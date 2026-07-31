import crypto from "node:crypto";
import { Badge, Button, IndexTable, Text,InlineStack,Card ,Modal,FormLayout,TextField ,BlockStack } from "@shopify/polaris";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams, useFetcher, Link, } from "react-router";
import { useState, useEffect, useCallback ,useMemo} from "react";
import prisma from "app/db.server";
import { authenticate, getAdminForShop } from "app/shopify.server";
import { PLAN_99, CUSTOM_PLAN } from "app/billing-plans.shared";
import { hasCustomPlanConfiguration } from "app/services/store.server";
import { sendSalesUserInvitationEmail } from "app/utils/email";
import { syncCompaniesFromShopify, syncCompaniesAndDetails } from "app/services/company.server";
import { syncShopifyUsers, syncShopifyOrders } from "app/utils/company.server";

const COMPANY_PICKER_LARGE_LIST_THRESHOLD = 100;
const COMPANY_PICKER_PAGE_SIZE = 50;

type CompanyOption = {
  id: string;
  name: string;
};

type SalesUserRow = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  isActive: boolean;
  invitation: {
    isActive: boolean;
    token: string;
  } | null;
  salesCompanies: Array<{
    company: {
      name: string;
    };
  }>;
};

type SalesUsersLoaderData = {
  salesUsers: SalesUserRow[];
  companies: CompanyOption[];
  storeId: string;
  appUrl: string;
};

// ── CACHE for sales users loader ────────────────────────────────
declare global {
  var __salesUsersCache:
    | Map<string, { data: unknown; timestamp: number }>
    | undefined;
}

const salesUsersCache: Map<string, { data: unknown; timestamp: number }> =
  globalThis.__salesUsersCache ?? (globalThis.__salesUsersCache = new Map());

const SALES_USERS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect, billing } = await authenticate.admin(request);

  // ── Check plan access ──
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  const hasCustomPlan = hasCustomPlanConfiguration(
    store?.customPlanKey,
    store?.planKey,
    store?.customAmount,
    store?.customPlanActive,
  );

  const normalizePlanName = (planName?: string | null) => {
    if (planName === "approved payment") {
      return "Paid subscription";
    }
    return planName || "free";
  };

  const currentPlanName = normalizePlanName(store?.plan);
  
  // Only PLAN_99 and CUSTOM_PLAN are allowed
  const hasAccess =
    currentPlanName === PLAN_99 ||
    currentPlanName === CUSTOM_PLAN ||
    hasCustomPlan;

  if (!hasAccess) {
    const returnTo = new URL(request.url).pathname + new URL(request.url).search;
    return redirect("/app/select-plan?returnTo=" + encodeURIComponent(returnTo));
  }

  // ── CACHE CHECK ──
  const cacheKey = `sales-users-${session.shop}`;
  const cached = salesUsersCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SALES_USERS_CACHE_TTL) {
    console.log(`⚡ Sales users cache HIT → ${cacheKey}`);
    return Response.json(cached.data);
  }

  console.log("🐢 Sales users cache MISS → querying DB");

  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

  const [salesUsers, companiesRaw] = await Promise.all([
    prisma.user.findMany({
      where: { shopId: store.id, role: "SALES_USER" },
      include: {
        invitation: true,
        salesCompanies: { include: { company: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.companyAccount.findMany({
      where: { shopId: store.id },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // Remove duplicate companies by name (keep first occurrence)
  const seenNames = new Map<string, boolean>();
  const companies = companiesRaw.filter((company) => {
    const normalizedName = company.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      console.log(`⚠️ Skipping duplicate company: ${company.name} (ID: ${company.id})`);
      return false;
    }
    seenNames.set(normalizedName, true);
    return true;
  });

  const result = { salesUsers, companies, storeId: store.id, appUrl: process.env.SHOPIFY_APP_URL };

  salesUsersCache.set(cacheKey, { data: result, timestamp: Date.now() });

  return Response.json(result);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json({ success: false, error: "Store not found" });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    const email = formData.get("email") as string;
    const firstName = formData.get("firstName") as string;
    const lastName = formData.get("lastName") as string;
    const companyIds = formData.getAll("companyIds") as string[];
    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await prisma.user.findFirst({
      where: { email: normalizedEmail, shopId: store.id, role: "SALES_USER" },
    });

    if (existingUser) {
      return Response.json({ success: false, error: "Email already exists" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days valid

    try {
      const user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          firstName,
          lastName,
          password: "PENDING",
          role: "SALES_USER",
          status: "PENDING",
          shopId: store.id,
          invitation: {
            create: {
              token,
              shopId: store.id,
              expiresAt,
              isActive: true,
            },
          },
          salesCompanies: {
            create: companyIds.map((id) => ({ companyId: id })),
          },
        },
      });

      const inviteLink = `${process.env.SHOPIFY_APP_URL}/support/login?storeid=${store.id}&userid=${user.id}&token=${token}`;
      await sendSalesUserInvitationEmail({
        storeId: store.id,
        email,
        firstName,
        inviteLink,
      });

      // Clear the cache so new user shows up immediately
      const cacheKey = `sales-users-${session.shop}`;
      salesUsersCache.delete(cacheKey);

      return Response.json({
        success: true,
        message: "Sales User Created and Invite Sent",
        intent: "create",
      });
    } catch (error: any) {
      if (error?.code === "P2002") {
        return Response.json({ success: false, error: "Email already exists" });
      }

      throw error;
    }
  }

  if (intent === "update") {
    const userId = formData.get("userId") as string;
    const email = formData.get("email") as string;
    const firstName = formData.get("firstName") as string;
    const lastName = formData.get("lastName") as string;
    const companyIds = formData.getAll("companyIds") as string[];
    const normalizedEmail = email.trim().toLowerCase();

    // Check if email is already taken by another user
    const existingUser = await prisma.user.findFirst({
      where: { 
        email: normalizedEmail, 
        shopId: store.id, 
        role: "SALES_USER",
        NOT: { id: userId },
      },
    });

    if (existingUser) {
      return Response.json({ success: false, error: "Email already exists" });
    }

    try {
      // Update user
      await prisma.user.update({
        where: { id: userId },
        data: {
          email: normalizedEmail,
          firstName,
          lastName,
        },
      });

      // Update company assignments
      // First, delete existing assignments
      await prisma.salesUserCompany.deleteMany({
        where: { userId },
      });

      // Then create new assignments
      await prisma.salesUserCompany.createMany({
        data: companyIds.map((companyId) => ({ userId, companyId })),
      });

      // Clear the cache so changes show up immediately
      const cacheKey = `sales-users-${session.shop}`;
      salesUsersCache.delete(cacheKey);

      return Response.json({
        success: true,
        message: "Sales User Updated Successfully",
        intent: "update",
      });
    } catch (error: any) {
      console.error("Error updating user:", error);
      return Response.json({ success: false, error: "Failed to update user" });
    }
  }

  if (intent === "deactivate" || intent === "activate") {
    const userId = formData.get("userId") as string;
    await prisma.user.update({
      where: { id: userId, shopId: store.id },
      data: { isActive: intent === "activate" },
    });
    
    // Clear the cache so changes show up immediately
    const cacheKey = `sales-users-${session.shop}`;
    salesUsersCache.delete(cacheKey);
    
    return Response.json({ success: true, message: `User ${intent}d` });
  }

  if (intent === "delete") {
    const userId = formData.get("userId") as string;
    
    // Check if user has created any orders
    const ordersCount = await prisma.b2BOrder.count({
      where: { createdByUserId: userId },
    });
    
    if (ordersCount > 0) {
      return Response.json({ 
        error: `Cannot delete user. They have ${ordersCount} order(s) associated with them. Please handle their orders before deleting.`,
        intent: "delete"
      }, { status: 400 });
    }
    
    // Check if user has created any quotes
    const quotesCount = await prisma.quote.count({
      where: { salesAgentId: userId },
    });
    
    if (quotesCount > 0) {
      return Response.json({ 
        error: `Cannot delete user. They have ${quotesCount} quote(s) associated with them. Please handle their quotes before deleting.`,
        intent: "delete"
      }, { status: 400 });
    }
    
    const deleteResult = await prisma.user.deleteMany({
      where: { id: userId, shopId: store.id },
    });

    if (deleteResult.count === 0) {
      return Response.json({
        error: "User could not be deleted because it no longer exists or is not assigned to this store.",
        intent: "delete"
      }, { status: 404 });
    }
    
    // Clear the cache so deletion shows up immediately
    const cacheKey = `sales-users-${session.shop}`;
    salesUsersCache.delete(cacheKey);
    
    return Response.json({ success: true, message: "User deleted", intent: "delete" });
  }

  if (intent === "generate_link") {
    const userId = formData.get("userId") as string;
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Update or create invitation
    await prisma.invitation.upsert({
      where: { userId },
      update: { token, expiresAt, isActive: true },
      create: {
        userId,
        shopId: store.id,
        token,
        expiresAt,
        isActive: true,
      },
    });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      const inviteLink = `${process.env.SHOPIFY_APP_URL}/support/login?storeid=${store.id}&userid=${userId}&token=${token}`;
      await sendSalesUserInvitationEmail({
        storeId: store.id,
        email: user.email,
        firstName: user.firstName || "there",
        inviteLink,
      });
    }

    // Clear the cache so changes show up immediately
    const cacheKey = `sales-users-${session.shop}`;
    salesUsersCache.delete(cacheKey);

    return Response.json({ success: true, message: "Link Generated and Invite Sent" });
  }

  if (intent === "resend_email") {
    const userId = formData.get("userId") as string;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { invitation: true }
    });

    if (user && user.invitation && user.invitation.isActive) {
      const inviteLink = `${process.env.SHOPIFY_APP_URL}/support/login?storeid=${store.id}&userid=${userId}&token=${user.invitation.token}`;
      await sendSalesUserInvitationEmail({
        storeId: store.id,
        email: user.email,
        firstName: user.firstName || "there",
        inviteLink,
      });
      
      // Clear the cache so changes show up immediately
      const cacheKey = `sales-users-${session.shop}`;
      salesUsersCache.delete(cacheKey);
      
      return Response.json({ success: true, message: "Email Resent Successfully" });
    }
    return Response.json({ success: false, error: "Active invitation not found" });
  }

  if (intent === "sync_companies") {
    try {
      const admin = await getAdminForShop(session.shop);
      const result = await syncCompaniesAndDetails(store.id, admin);

      const cacheKey = `sales-users-${session.shop}`;
      salesUsersCache.delete(cacheKey);

      return Response.json({
        success: true,
        intent: "sync_companies",
        createdCount: result.createdCount,
        updatedCount: result.updatedCount,
        totalSynced: result.totalSynced,
        message: result.message,
        companiesWithCustomers: result.companiesWithCustomers,
        companiesWithLocations: result.companiesWithLocations,
        companiesWithSyncedUsers: result.companiesWithSyncedUsers,
        usersSynced: result.usersSynced,
      });
    } catch (error: any) {
      console.error("Error syncing companies:", error);
      return Response.json({
        success: false,
        error: error.message || "Failed to sync companies from Shopify",
      });
    }
  }

  if (intent === "sync_user_companies") {
    const userId = formData.get("userId") as string;
    if (!userId) {
      return Response.json({ success: false, error: "User ID is required" });
    }

    try {
      const admin = await getAdminForShop(session.shop);

      const userCompanies = await prisma.salesUserCompany.findMany({
        where: { userId },
        include: { company: { select: { id: true, name: true } } },
      });

      if (userCompanies.length === 0) {
        return Response.json({
          success: true,
          intent: "sync_user_companies",
          message: "No companies assigned to this user.",
        });
      }

      let usersSynced = 0;
      let ordersSynced = 0;
      const errors: string[] = [];

      for (const { company } of userCompanies) {
        const userSyncResult = await syncShopifyUsers(admin, store, company.id);
        if (userSyncResult.success) {
          usersSynced += userSyncResult.syncedCount || 0;
        } else {
          errors.push(
            `"${company.name}" user sync: ${userSyncResult.message || "failed"}`,
          );
        }

        const orderSyncResult = await syncShopifyOrders(admin, store, company.id);
        if (orderSyncResult.success) {
          ordersSynced += orderSyncResult.syncedCount || 0;
        } else {
          errors.push(
            `"${company.name}" order sync: ${orderSyncResult.message || "failed"}`,
          );
        }
      }

      const cacheKey = `sales-users-${session.shop}`;
      salesUsersCache.delete(cacheKey);

      return Response.json({
        success: true,
        intent: "sync_user_companies",
        message:
          `Synced ${userCompanies.length} compan${userCompanies.length === 1 ? "y" : "ies"}` +
          ` — ${usersSynced} user${usersSynced === 1 ? "" : "s"} synced, ${ordersSynced} order${ordersSynced === 1 ? "" : "s"} synced` +
          (errors.length ? `; Errors: ${errors.join("; ")}` : ""),
        usersSynced,
        ordersSynced,
        errors,
      });
    } catch (error: any) {
      console.error("Error syncing user companies:", error);
      return Response.json({
        success: false,
        error: error.message || "Failed to sync user companies from Shopify",
      });
    }
  }

  return Response.json({ success: false, error: "Unknown intent" });
};

export default function SalesUsers() {
  const { salesUsers, companies, storeId, appUrl } =
    useLoaderData<typeof loader>() as unknown as SalesUsersLoaderData;
  const fetcher = useFetcher();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncingUserIds, setSyncingUserIds] = useState<Set<string>>(new Set());
  const [isCreating, setIsCreating] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [isClient, setIsClient] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<string[]>([]);
  const [companySearch, setCompanySearch] = useState("");
  const [companyPickerPage, setCompanyPickerPage] = useState(1);
  const [errorMessage, setErrorMessage] = useState("");

  const [editEmail, setEditEmail] = useState("");
  const [editFirstName, setEditFirstName] = useState("");
  const [editLastName, setEditLastName] = useState("");
  const [editSelectedCompanyIds, setEditSelectedCompanyIds] = useState<string[]>([]);
  const [editCompanySearch, setEditCompanySearch] = useState("");
  const [editCompanyPickerPage, setEditCompanyPickerPage] = useState(1);
  const [editErrorMessage, setEditErrorMessage] = useState("");

  // Ensure IndexTable only renders on client to avoid SSR hydration mismatch
  useEffect(() => {
    setIsClient(true);
  }, []);

  const toggleModal = useCallback(() => {
    setIsModalOpen((open) => {
      if (!open) {
        // Opening modal — pre-select all companies
        setSelectedCompanyIds(companies.map((c) => c.id));
        setCompanySearch("");
        setCompanyPickerPage(1);
      } else {
        setErrorMessage("");
      }
      return !open;
    });
  }, [companies]);

  const toggleEditModal = useCallback((user?: SalesUserRow) => {
    setIsEditModalOpen((open) => {
      if (!open && user) {
        // Opening edit modal — populate with user data
        setEditingUserId(user.id);
        setEditFirstName(user.firstName || "");
        setEditLastName(user.lastName || "");
        setEditEmail(user.email);
        setEditSelectedCompanyIds(user.salesCompanies.map((sc) => {
          const company = companies.find((c) => c.name === sc.company.name);
          return company ? company.id : "";
        }).filter(Boolean));
        setEditCompanySearch("");
        setEditCompanyPickerPage(1);
        setEditErrorMessage("");
      } else {
        setEditErrorMessage("");
        setEditingUserId(null);
      }
      return !open;
    });
  }, [companies]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data?.success && fetcher.data?.intent === "create") {
        setIsCreating(false);
        setIsModalOpen(false);
        setFirstName("");
        setLastName("");
        setEmail("");
        setSelectedCompanyIds([]);
        setCompanySearch("");
        setCompanyPickerPage(1);
        setErrorMessage("");
      } else if (fetcher.data?.success && fetcher.data?.intent === "update") {
        setIsUpdating(false);
        setIsEditModalOpen(false);
        setEditingUserId(null);
        setEditFirstName("");
        setEditLastName("");
        setEditEmail("");
        setEditSelectedCompanyIds([]);
        setEditCompanySearch("");
        setEditCompanyPickerPage(1);
        setEditErrorMessage("");
      } else if (fetcher.data?.success && fetcher.data?.intent === "sync_companies") {
        setSyncMessage(fetcher.data.message);
        setIsSyncing(false);
        setTimeout(() => setSyncMessage(""), 3000);
      } else if (fetcher.data?.success && fetcher.data?.intent === "sync_user_companies") {
        setSyncingUserIds(new Set());
        setSyncMessage(fetcher.data.message);
        setTimeout(() => setSyncMessage(""), 3000);
      } else if (fetcher.data?.success && fetcher.data?.intent === "delete") {
        setDeleteError("");
        // Reload or refresh the page to show updated user list
        window.location.reload();
      } else if (fetcher.data?.error) {
        if (fetcher.data?.intent === "sync_companies") {
          setSyncMessage(`Error: ${fetcher.data.error}`);
          setIsSyncing(false);
        } else if (fetcher.data?.intent === "sync_user_companies") {
          setSyncingUserIds(new Set());
          setSyncMessage(`Error: ${fetcher.data.error}`);
        } else if (fetcher.data?.intent === "update") {
          setEditErrorMessage(fetcher.data.error);
          setIsUpdating(false);
        } else if (fetcher.data?.intent === "delete") {
          setDeleteError(fetcher.data.error);
        } else {
          setErrorMessage(fetcher.data.error);
          setIsCreating(false);
        }
      }
    }
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    setCompanyPickerPage(1);
  }, [companySearch]);

  useEffect(() => {
    setEditCompanyPickerPage(1);
  }, [editCompanySearch]);

  const handleCreate = () => {
    // Validate required fields
    if (!email.trim()) {
      setErrorMessage("Email is required");
      return;
    }
    if (!firstName.trim()) {
      setErrorMessage("First name is required");
      return;
    }
    if (!lastName.trim()) {
      setErrorMessage("Last name is required");
      return;
    }

    setErrorMessage(""); // Clear any previous errors
    setIsCreating(true);
    const formData = new FormData();
    formData.append("intent", "create");
    formData.append("email", email);
    formData.append("firstName", firstName);
    formData.append("lastName", lastName);
    selectedCompanyIds.forEach(id => formData.append("companyIds", id));

    fetcher.submit(formData, { method: "post" });
  };

  const handleEdit = (user: SalesUserRow) => {
    toggleEditModal(user);
  };

  const handleUpdate = () => {
    // Validate required fields
    if (!editEmail.trim()) {
      setEditErrorMessage("Email is required");
      return;
    }
    if (!editFirstName.trim()) {
      setEditErrorMessage("First name is required");
      return;
    }
    if (!editLastName.trim()) {
      setEditErrorMessage("Last name is required");
      return;
    }

    setEditErrorMessage(""); // Clear any previous errors
    setIsUpdating(true);
    const formData = new FormData();
    formData.append("intent", "update");
    formData.append("userId", editingUserId || "");
    formData.append("email", editEmail);
    formData.append("firstName", editFirstName);
    formData.append("lastName", editLastName);
    editSelectedCompanyIds.forEach(id => formData.append("companyIds", id));

    fetcher.submit(formData, { method: "post" });
  };

  const handleToggleStatus = (userId: string, currentStatus: boolean) => {
    fetcher.submit(
      { intent: currentStatus ? "deactivate" : "activate", userId },
      { method: "post" }
    );
  };

  const handleGenerateLink = (userId: string) => {
    fetcher.submit(
      { intent: "generate_link", userId },
      { method: "post" }
    );
  };

  const handleResendEmail = (userId: string) => {
    fetcher.submit(
      { intent: "resend_email", userId },
      { method: "post" }
    );
  };

  const handleDelete = (userId: string) => {
    if (confirm("Are you sure you want to delete this sales user? This action cannot be undone.")) {
      fetcher.submit(
        { intent: "delete", userId },
        { method: "post" }
      );
    }
  };

  const handleSyncCompanies = () => {
    setIsSyncing(true);
    setSyncMessage("");
    fetcher.submit(
      { intent: "sync_companies" },
      { method: "post" }
    );
  };

  const handleSyncUserCompanies = (userId: string) => {
    setSyncingUserIds((prev) => new Set(prev).add(userId));
    setSyncMessage("");
    fetcher.submit(
      { intent: "sync_user_companies", userId },
      { method: "post" }
    );
  };

  const normalizedCompanySearch = companySearch.trim().toLowerCase();
  const filteredCompanies = useMemo(
    () =>
      companies.filter((company) =>
        company.name.toLowerCase().includes(normalizedCompanySearch),
      ),
    [companies, normalizedCompanySearch],
  );
  const shouldPaginateCompanyPicker =
    companies.length >= COMPANY_PICKER_LARGE_LIST_THRESHOLD &&
    filteredCompanies.length > COMPANY_PICKER_PAGE_SIZE;
  const totalCompanyPages = Math.max(
    1,
    Math.ceil(filteredCompanies.length / COMPANY_PICKER_PAGE_SIZE),
  );
  const visibleCompanies = shouldPaginateCompanyPicker
    ? filteredCompanies.slice(
        (companyPickerPage - 1) * COMPANY_PICKER_PAGE_SIZE,
        companyPickerPage * COMPANY_PICKER_PAGE_SIZE,
      )
    : filteredCompanies;
  const selectedCompanyCount = selectedCompanyIds.length;

  const toggleCompanySelection = (companyId: string) => {
    setSelectedCompanyIds((current) =>
      current.includes(companyId)
        ? current.filter((id) => id !== companyId)
        : [...current, companyId],
    );
  };

  const selectAllFilteredCompanies = () => {
    const filteredCompanyIds = filteredCompanies.map((company) => company.id);
    setSelectedCompanyIds((current) => Array.from(new Set([...current, ...filteredCompanyIds])));
  };

  const clearAllCompanies = () => {
    setSelectedCompanyIds([]);
  };

  const selectAllEditCompanies = () => {
    const filteredCompanyIds = filteredEditCompanies.map((company) => company.id);
    setEditSelectedCompanyIds((current) => Array.from(new Set([...current, ...filteredCompanyIds])));
  };

  const clearAllEditCompanies = () => {
    setEditSelectedCompanyIds([]);
  };

  const toggleEditCompanySelection = (companyId: string) => {
    setEditSelectedCompanyIds((current) =>
      current.includes(companyId)
        ? current.filter((id) => id !== companyId)
        : [...current, companyId],
    );
  };

  const normalizedEditCompanySearch = editCompanySearch.trim().toLowerCase();
  const filteredEditCompanies = useMemo(
    () =>
      companies.filter((company) =>
        company.name.toLowerCase().includes(normalizedEditCompanySearch),
      ),
    [companies, normalizedEditCompanySearch],
  );
  const shouldPaginateEditCompanyPicker =
    companies.length >= COMPANY_PICKER_LARGE_LIST_THRESHOLD &&
    filteredEditCompanies.length > COMPANY_PICKER_PAGE_SIZE;
  const totalEditCompanyPages = Math.max(
    1,
    Math.ceil(filteredEditCompanies.length / COMPANY_PICKER_PAGE_SIZE),
  );
  const visibleEditCompanies = shouldPaginateEditCompanyPicker
    ? filteredEditCompanies.slice(
        (editCompanyPickerPage - 1) * COMPANY_PICKER_PAGE_SIZE,
        editCompanyPickerPage * COMPANY_PICKER_PAGE_SIZE,
      )
    : filteredEditCompanies;
  const editSelectedCompanyCount = editSelectedCompanyIds.length;

  const portalLoginUrl = `${appUrl}/sales/login`;

  const rowMarkup = salesUsers.map(
    ({ id, email, firstName, lastName, status, isActive, invitation, salesCompanies }, index) => {
      
      const link = invitation?.isActive 
        ? `${appUrl}/support/login?storeid=${storeId}&userid=${id}&token=${invitation.token}` 
        : null;

      const isApproved = status === "APPROVED";

      return (
        <IndexTable.Row id={id} key={id} position={index}>
          <IndexTable.Cell>
            <Text variant="bodyMd" fontWeight="bold" as="span">
              {firstName} {lastName}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>{email}</IndexTable.Cell>
          <IndexTable.Cell>
            {salesCompanies.map(sc => sc.company.name).join(", ")}
          </IndexTable.Cell>
          <IndexTable.Cell>
            {isActive ? <Badge tone="success">Active</Badge> : <Badge tone="critical">Inactive</Badge>}
          </IndexTable.Cell>
          <IndexTable.Cell>
            <InlineStack gap="200" align="start">
              <Button size="micro" onClick={() => handleEdit({ id, email, firstName, lastName, status, isActive, invitation, salesCompanies })}>Edit</Button>
              <Button size="micro" onClick={() => handleToggleStatus(id, isActive)} tone={isActive ? "critical" : "success"}>
                {isActive ? "Deactivate" : "Activate"}
              </Button>
              {!link && (
                <Button size="micro" onClick={() => handleGenerateLink(id)}>Generate Link</Button>
              )}
              {link && (
                <>
                  <Button size="micro" onClick={() => handleResendEmail(id)}>Resend Email</Button>
                </>
              )}
              <Button
                size="micro"
                onClick={() => handleSyncUserCompanies(id)}
                loading={syncingUserIds.has(id)}
                disabled={syncingUserIds.has(id)}
              >
                {syncingUserIds.has(id) ? "Syncing..." : "Sync Company"}
              </Button>
              <Button size="micro" tone="critical" onClick={() => handleDelete(id)}>Delete</Button>
            </InlineStack>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    }
  );

  const pageShellStyle = {
    background: "#f1f2f4",
    minHeight: "100vh",
    padding: "24px",
    boxSizing: "border-box",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  } as const;

  const pageHeroStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto 18px",
    padding: "0px 0px 16px 0px",  
    borderRadius: 14,
    border: "1px solid #dfe3e8",
    background: "linear-gradient(135deg, #ffffff 0%)",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
  } as const;

  const pageHeroTitleStyle = {
    fontSize: "22px",
    lineHeight: 1.15,
    fontWeight: 650,
    color: "#202223",
    margin: "15px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center"
  } as const;

  const pageHeroTextStyle = {
    fontSize: "14px",
    color: "#5c5f62",
    margin: "0 15px 0",
  } as const;

  const contentPanelStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto",
    boxSizing: "border-box",
  } as const;

  const companyPickerHeaderStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
    marginBottom: "10px",
  } as const;

  const companyPickerCountStyle = {
    fontSize: "13px",
    color: "#5c5f62",
    fontWeight: 600,
  } as const;

  const companyPickerActionsStyle = {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  } as const;

  const companyPickerListStyle = {
    border: "1px solid #dfe3e8",
    borderRadius: "10px",
    maxHeight: "300px",
    overflowY: "auto",
    background: "#ffffff",
  } as const;

  const companyPickerRowStyle = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 12px",
    cursor: "pointer",
    borderBottom: "1px solid #f1f2f4",
    transition: "background-color 0.15s ease",
  } as const;

  const companyPickerEmptyStyle = {
    padding: "28px 16px",
    textAlign: "center",
    color: "#6d7175",
    background: "#ffffff",
  } as const;

  const companyPickerPaginationStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    marginTop: "10px",
  } as const;

  return (
    <div style={pageShellStyle}>
      <div style={pageHeroStyle}>
        <Link
          to="/app"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            color: "#2c6ecb",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 600,
            margin: "15px 15px 5px",
          }}
        >
          <svg
            viewBox="0 0 20 20"
            style={{ width: "16px", height: "16px" }}
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
              clipRule="evenodd"
            />
          </svg>
          Back to Dashboard
        </Link>
        <div style={pageHeroTitleStyle}>
          Sales Users
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Button onClick={handleSyncCompanies} loading={isSyncing} disabled={isSyncing} variant="secondary">
              {isSyncing ? "Syncing..." : "Sync All Companies"}
            </Button>
            <Button variant="primary" onClick={toggleModal} loading={isCreating} disabled={isCreating}>
              {isCreating ? "Creating..." : "Create Sales User"}
            </Button>
          </div>
        </div>
        <p style={pageHeroTextStyle}>
          Manage sales users, assign them to companies, and control their access.
        </p>
        {deleteError && (
          <div style={{ padding: "12px 16px", backgroundColor: "#fce4e6", border: "1px solid #f08080", borderRadius: "4px", color: "#c23030", marginTop: "12px", marginBottom: "12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
              <div style={{ flex: 1 }}>{deleteError}</div>
              <button 
                onClick={() => setDeleteError("")}
                style={{ background: "none", border: "none", color: "#c23030", cursor: "pointer", fontSize: "16px", padding: "0" }}
              >
                ×
              </button>
            </div>
          </div>
        )}
      </div>
      
      <div style={contentPanelStyle}>
        {/* Sales Portal Login URL Banner */}
        <div style={{
          marginBottom: "16px",
          padding: "14px 18px",
          borderRadius: "12px",
          backgroundColor: "#fff0f4",
          border: "1px solid #f8d7e3",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap" as const,
        }}>
          <div>
            <Text variant="bodyMd" fontWeight="semibold" as="span">Sales Portal Login: </Text>
            <Text variant="bodyMd" as="span">{portalLoginUrl}</Text>
          </div>
          <Button size="micro" onClick={() => navigator.clipboard.writeText(portalLoginUrl)}>
            Copy URL
          </Button>
        </div>

        {isClient && (
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "user", plural: "users" }}
              itemCount={salesUsers.length}
              headings={[
                { title: "Name" },
                { title: "Email" },
                { title: "Assigned Companies" },
                { title: "Status" },
                { title: "Actions" },
              ]}
              selectable={false}
            >
              {rowMarkup}
            </IndexTable>
          </Card>
        )}
      <Modal
        open={isModalOpen}
        onClose={toggleModal}
        title="Create New Sales User"
        primaryAction={{
          content: "Create",
          onAction: handleCreate,
          loading: isCreating,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: toggleModal,
            disabled: isCreating,
          },
        ]}
      >
        <Modal.Section>
          {errorMessage && (
            <div
              style={{
                padding: "12px 16px",
                marginBottom: "16px",
                borderRadius: "6px",
                backgroundColor: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#dc2626",
                fontSize: "14px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <svg
                viewBox="0 0 20 20"
                style={{ width: "18px", height: "18px", flexShrink: 0 }}
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0V5.75A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
              {errorMessage}
            </div>
          )}
          <FormLayout>
            <TextField
              label="First Name"
              value={firstName}
              onChange={setFirstName}
              autoComplete="off"
            />
            <TextField
              label="Last Name"
              value={lastName}
              onChange={setLastName}
              autoComplete="off"
            />
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
            />
            <BlockStack gap="300">
              <div style={companyPickerHeaderStyle}>
                <Text variant="headingSm" as="h3">Assign Companies</Text>
                <span style={companyPickerCountStyle}>
                  {selectedCompanyCount} {selectedCompanyCount === 1 ? "company" : "companies"} selected
                </span>
              </div>

              <TextField
                label="Search companies"
                labelHidden
                placeholder="Search companies by name..."
                value={companySearch}
                onChange={setCompanySearch}
                autoComplete="off"
              />

              <div style={companyPickerActionsStyle}>
                <Button
                  size="micro"
                  onClick={selectAllFilteredCompanies}
                  disabled={filteredCompanies.length === 0}
                >
                  Select All
                </Button>
                <Button
                  size="micro"
                  onClick={clearAllCompanies}
                  disabled={selectedCompanyIds.length === 0}
                >
                  Clear All
                </Button>
                <Text variant="bodySm" tone="subdued" as="span">
                  {filteredCompanies.length} {filteredCompanies.length === 1 ? "match" : "matches"}
                </Text>
              </div>

              <div style={companyPickerListStyle} role="group" aria-label="Assign companies">
                {visibleCompanies.length > 0 ? (
                  visibleCompanies.map((company, index) => {
                    const isSelected = selectedCompanyIds.includes(company.id);
                    const baseBackground = index % 2 === 0 ? "#ffffff" : "#fafbfb";

                    return (
                      <label
                        key={company.id}
                        style={{
                          ...companyPickerRowStyle,
                          backgroundColor: isSelected ? "#f0f7ff" : baseBackground,
                        }}
                        onMouseEnter={(event) => {
                          event.currentTarget.style.backgroundColor = isSelected ? "#e4f0ff" : "#f6f6f7";
                        }}
                        onMouseLeave={(event) => {
                          event.currentTarget.style.backgroundColor = isSelected ? "#f0f7ff" : baseBackground;
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleCompanySelection(company.id)}
                          style={{
                            width: "16px",
                            height: "16px",
                            accentColor: "#2c6ecb",
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ fontSize: "14px", color: "#202223", lineHeight: 1.35 }}>
                          {company.name}
                        </span>
                      </label>
                    );
                  })
                ) : (
                  <div style={companyPickerEmptyStyle}>
                    No companies found
                  </div>
                )}
              </div>

              {shouldPaginateCompanyPicker && (
                <div style={companyPickerPaginationStyle}>
                  <Button
                    size="micro"
                    onClick={() => setCompanyPickerPage((page) => Math.max(1, page - 1))}
                    disabled={companyPickerPage <= 1}
                  >
                    Previous
                  </Button>
                  <Text variant="bodySm" tone="subdued" as="span">
                    Page {companyPickerPage} of {totalCompanyPages}
                  </Text>
                  <Button
                    size="micro"
                    onClick={() => setCompanyPickerPage((page) => Math.min(totalCompanyPages, page + 1))}
                    disabled={companyPickerPage >= totalCompanyPages}
                  >
                    Next
                  </Button>
                </div>
              )}
            </BlockStack>
          </FormLayout>
          
          <div style={{
            padding: "16px 0",
            borderTop: "1px solid #dfe3e8",
            marginTop: "16px",
          }}>
            <div style={{
              padding: "12px 16px",
              borderRadius: "8px",
              backgroundColor: "#f0f7ff",
              border: "1px solid #bfdbfe",
              marginBottom: "12px",
            }}>
              <Text variant="bodySm" tone="subdued" as="span">
                💡 If companies from Shopify are not showing in the list above, click the sync button below to fetch them.
              </Text>
            </div>
            {syncMessage && (
              <div style={{
                padding: "12px 16px",
                marginBottom: "12px",
                borderRadius: "6px",
                backgroundColor: syncMessage.includes("Error") ? "#fef2f2" : "#f0fdf4",
                border: syncMessage.includes("Error") ? "1px solid #fecaca" : "1px solid #bbf7d0",
                color: syncMessage.includes("Error") ? "#dc2626" : "#15803d",
                fontSize: "13px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}>
                <svg
                  viewBox="0 0 20 20"
                  style={{ width: "18px", height: "18px", flexShrink: 0 }}
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
                    clipRule="evenodd"
                  />
                </svg>
                {syncMessage}
              </div>
            )}
            <Button
              onClick={handleSyncCompanies}
              disabled={isSyncing}
              loading={isSyncing}
              variant="secondary"
              fullWidth
            >
              {isSyncing ? "Syncing Companies..." : "Sync Companies from Shopify"}
            </Button>
          </div>
        </Modal.Section>
      </Modal>
      
      {/* Edit Sales User Modal */}
      <Modal open={isEditModalOpen} onClose={() => {
        setIsEditModalOpen(false);
        setEditingUserId(null);
        setEditFirstName("");
        setEditLastName("");
        setEditEmail("");
        setEditSelectedCompanyIds([]);
        setEditCompanySearch("");
        setEditCompanyPickerPage(1);
        setEditErrorMessage("");
      }} title="Edit Sales User">
        <Modal.Section>
          <div style={{ paddingBottom: "16px" }}>
            <FormLayout>
              {editErrorMessage && (
                <div style={{ padding: "12px", backgroundColor: "#fce4e6", border: "1px solid #f08080", borderRadius: "4px", color: "#c23030", marginBottom: "12px" }}>
                  {editErrorMessage}
                </div>
              )}
              
              <TextField
                label="Email"
                type="email"
                value={editEmail}
                onChange={setEditEmail}
                disabled={isUpdating}
                autoComplete="email"
              />
              
              <TextField
                label="First Name"
                value={editFirstName}
                onChange={setEditFirstName}
                disabled={isUpdating}
                autoComplete="given-name"
              />
              
              <TextField
                label="Last Name"
                value={editLastName}
                onChange={setEditLastName}
                disabled={isUpdating}
                autoComplete="family-name"
              />
              
              <div>
                <div style={{ marginBottom: "8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Text variant="headingMd" as="h3">Companies</Text>
                  <Text variant="bodySm" as="p">{editSelectedCompanyCount} selected</Text>
                </div>
                
                <TextField
                  placeholder="Search companies..."
                  value={editCompanySearch}
                  onChange={setEditCompanySearch}
                  disabled={isUpdating}
                  label=""
                  autoComplete="off"
                  connectedRight={
                    <Button
                      variant="plain"
                      size="micro"
                      onClick={editSelectedCompanyIds.length === visibleEditCompanies.length && visibleEditCompanies.length > 0 ? clearAllEditCompanies : selectAllEditCompanies}
                      disabled={isUpdating || visibleEditCompanies.length === 0}
                    >
                      {editSelectedCompanyIds.length === visibleEditCompanies.length && visibleEditCompanies.length > 0 ? "Clear All" : "Select All"}
                    </Button>
                  }
                />
                
                {visibleEditCompanies.length > 0 ? (
                  <div style={{ border: "1px solid #e1e4e8", borderRadius: "4px", maxHeight: "300px", overflowY: "auto", marginTop: "8px" }}>
                    {visibleEditCompanies.map((company) => (
                      <div key={company.id} style={{ padding: "8px 12px", borderBottom: "1px solid #e1e4e8", display: "flex", alignItems: "center", gap: "8px" }}>
                        <input
                          type="checkbox"
                          checked={editSelectedCompanyIds.includes(company.id)}
                          onChange={() => toggleEditCompanySelection(company.id)}
                          disabled={isUpdating}
                        />
                        <span>{company.name}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: "12px", textAlign: "center", color: "#666", marginTop: "8px" }}>
                    {editCompanySearch ? "No companies found" : "No companies available"}
                  </div>
                )}
                
                {shouldPaginateEditCompanyPicker && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px" }}>
                    <Button
                      variant="plain"
                      size="micro"
                      onClick={() => setEditCompanyPickerPage(p => Math.max(1, p - 1))}
                      disabled={editCompanyPickerPage === 1 || isUpdating}
                    >
                      Previous
                    </Button>
                    <Text variant="bodySm" as="p">Page {editCompanyPickerPage} of {totalEditCompanyPages}</Text>
                    <Button
                      variant="plain"
                      size="micro"
                      onClick={() => setEditCompanyPickerPage(p => Math.min(totalEditCompanyPages, p + 1))}
                      disabled={editCompanyPickerPage === totalEditCompanyPages || isUpdating}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </div>
              
              <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
                <Button
                  variant="primary"
                  onClick={handleUpdate}
                  disabled={isUpdating}
                  loading={isUpdating}
                  fullWidth
                >
                  {isUpdating ? "Updating..." : "Update"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setIsEditModalOpen(false);
                    setEditingUserId(null);
                    setEditFirstName("");
                    setEditLastName("");
                    setEditEmail("");
                    setEditSelectedCompanyIds([]);
                    setEditCompanySearch("");
                    setEditCompanyPickerPage(1);
                    setEditErrorMessage("");
                  }}
                  disabled={isUpdating}
                  fullWidth
                >
                  Cancel
                </Button>
              </div>
            </FormLayout>
          </div>
        </Modal.Section>
      </Modal>
      </div>
    </div>
  );
}
