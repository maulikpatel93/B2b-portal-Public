import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  redirect,
  useLoaderData,
  Link,
  Form,
  useNavigation,
  useActionData,
  useSearchParams,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import { Prisma } from "@prisma/client";
import prisma from "app/db.server";
import {
  requireSalesSession,
  hasCompanyAccess,
  buildClearSessionCookie,
} from "app/utils/sales-session.server";
import { restoreCredit } from "app/services/creditService";
import { getAdminForShop } from "app/shopify.server";
import {
  assignCompanyToCustomer,
  checkCustomerExists,
  createShopifyCompany,
  createShopifyCustomer,
} from "app/utils/b2b-customer.server";
import {
  SalesPortalHeader,
  SalesPortalLayout,
  salesPortalButtonStyles,
} from "app/components/SalesPortalLayout";
import {
  getOrCreateSalesOrderPaymentLink,
  getOrderNumber,
  getShopifyOrderWhere,
  isSalesPortalPaymentLinkEligible,
  logOrderActivity,
  fetchShopifyOrderNames,
} from "app/services/sales-order-management.server";
import { createUser } from "app/services/user.server";
import {
  formatPhoneNumberForCountry,
  getDialCodeForCountry,
} from "app/utils/company-create-form";

type CreateCompanyCountryOption = {
  value: string;
  label: string;
  dialCode?: string;
  provinces: Array<{ value: string; label: string }>;
};

// ⚠️ NOTE: isSalesPortalPaymentLinkEligible is only called inside loader/action
// (server-only exports). It must NOT be called in the component body.

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);

  const url = new URL(request.url);
  const companyIdParam = url.searchParams.get("company") || "";

  const companies = user.salesCompanies.map((sc) => ({
    id: sc.company.id,
    name: sc.company.name,
  }));

  if (!companies.length) return redirect("/sales/portal");

  const selectedCompanyId =
    companyIdParam || (companies.length > 1 ? "all" : companies[0].id);

  const currentCompany =
    selectedCompanyId === "all"
      ? { id: "all", name: "All companies" }
      : companies.find((c) => c.id === selectedCompanyId) || companies[0];

  if (selectedCompanyId !== "all") {
    if (!hasCompanyAccess(user, selectedCompanyId)) {
      return redirect("/sales/portal");
    }
  }

  const filterCompanyIds =
    selectedCompanyId === "all"
      ? user.salesCompanies.map((sc) => sc.companyId)
      : [selectedCompanyId];

  const companyIdsForQuery =
    selectedCompanyId === "all"
      ? user.salesCompanies.map((sc) => sc.companyId)
      : [selectedCompanyId];

  const orders = await prisma.b2BOrder.findMany({
    where: {
      AND: [
        {
          companyId: { in: companyIdsForQuery },
          orderStatus: { notIn: ["converted", "archived"] },
        },
        getShopifyOrderWhere(),
      ],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      shopifyOrderId: true,
      orderNumber: true,
      orderTotal: true,
      paymentStatus: true,
      orderStatus: true,
      createdAt: true,
      remainingBalance: true,
      currencyCode: true,
      customerName: true,
      customerEmail: true,
      source: true,
      paymentLink: true,
      paymentLinkToken: true,
      items: { select: { quantity: true } },
      company: {
        select: {
          id: true,
          name: true,
          shop: { select: { shopDomain: true, accessToken: true } },
        },
      },
      createdByUser: {
        select: { firstName: true, lastName: true, email: true },
      },
    },
  });

  const orderNames = await fetchShopifyOrderNames(orders);

  const quoteCount =
    selectedCompanyId === "all"
      ? await prisma.quote.count({
          where: { companyId: { in: companyIdsForQuery } },
        })
      : await prisma.quote.count({
          where: { companyId: selectedCompanyId },
        });

  return Response.json({
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    company: {
      id: currentCompany.id,
      name: currentCompany.name,
      creditLimit: "0",
      themeColor: null,
      storeName: null,
    },
    orders: orders.map((o) => ({
      id: o.id,
      shopifyOrderId: o.shopifyOrderId,
      orderNumber: getOrderNumber(o),
      shopifyOrderName: orderNames.get(o.id) || null,
      orderTotal: o.orderTotal?.toString() || "0",
      paymentStatus: o.paymentStatus,
      orderStatus: o.orderStatus,
      remainingBalance: o.remainingBalance?.toString() || "0",
      currencyCode: o.currencyCode,
      customerName: o.customerName,
      customerEmail: o.customerEmail,
      source: o.source,
      paymentLink: o.paymentLink,
      paymentLinkToken: o.paymentLinkToken,
      itemCount: o.items.length,
      quantity: o.items.reduce((sum, item) => sum + item.quantity, 0),
      createdAt: o.createdAt.toISOString(),
      canGeneratePaymentLink: isSalesPortalPaymentLinkEligible(o),
      companyName: o.company?.name || null,
      createdByUser: o.createdByUser,
    })),
    createOrderCompanyId: companies[0]?.id || "",
    quoteCount,
    allCompanies: companies,
    selectedCompanyId,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;

  if (!companyId || !hasCompanyAccess(user, companyId)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "logout") {
    return redirect("/sales/login", {
      headers: {
        "Set-Cookie": buildClearSessionCookie(),
      },
    });
  }

  if (intent === "createCompany") {
    if (!user.shopId) {
      return Response.json(
        { error: "Your sales account is not linked to a store." },
        { status: 400 },
      );
    }

    const store = await prisma.store.findUnique({
      where: { id: user.shopId },
      select: {
        id: true,
        shopDomain: true,
        defaultCompanyCreditLimit: true,
      },
    });

    if (!store) {
      return Response.json({ error: "Store not found." }, { status: 404 });
    }

    const companyName = String(formData.get("companyName") || "").trim();
    const locationName =
      String(formData.get("locationName") || "").trim() || companyName;
    const customerEmail = String(formData.get("customerEmail") || "")
      .trim()
      .toLowerCase();
    const firstName = String(formData.get("firstName") || "").trim();
    const lastName = String(formData.get("lastName") || "").trim();
    const phone = String(formData.get("phone") || "").trim();
    const provinceCode = String(formData.get("provinceCode") || "").trim();
    const countryCode = String(formData.get("countryCode") || "").trim();
    const formattedPhone = formatPhoneNumberForCountry(phone, countryCode);
    const address1 = String(formData.get("address1") || "").trim();
    const address2 = String(formData.get("address2") || "").trim();
    const city = String(formData.get("city") || "").trim();
    const zip = String(formData.get("zip") || "").trim();

    if (!companyName || !customerEmail || !firstName || !lastName) {
      return Response.json(
        {
          error:
            "Company name, customer email, first name and last name are required.",
        },
        { status: 400 },
      );
    }

    const admin = (await getAdminForShop(store.shopDomain)) as any;

    const existingCompany = await prisma.companyAccount.findFirst({
      where: {
        shopId: store.id,
        name: { equals: companyName, mode: "insensitive" },
      },
      select: { id: true },
    });

    if (existingCompany) {
      await prisma.salesUserCompany.upsert({
        where: {
          userId_companyId: {
            userId: user.id,
            companyId: existingCompany.id,
          },
        },
        update: {},
        create: { userId: user.id, companyId: existingCompany.id },
      });

      return redirect(
        `/sales/portal/company/${existingCompany.id}/orders?companyLinked=1`,
      );
    }

    const customerCheck = await checkCustomerExists(admin, customerEmail);
    if (!customerCheck.success) {
      return Response.json({ error: customerCheck.error }, { status: 400 });
    }

    let customerId =
      customerCheck.exists && customerCheck.customer
        ? customerCheck.customer.id
        : "";

    if (!customerId) {
      const customerCreate = await createShopifyCustomer(admin, {
        email: customerEmail,
        firstName,
        lastName,
        phone: formattedPhone,
      });

      if (!customerCreate.success || !customerCreate.customer?.id) {
        return Response.json(
          { error: customerCreate.error || "Failed to create customer." },
          { status: 400 },
        );
      }

      customerId = customerCreate.customer.id;
    }

    const companyCreate = await createShopifyCompany(admin, {
      name: companyName,
      externalId: `sales-${user.id}-${Date.now()}`,
    });

    if (!companyCreate.success || !companyCreate.company?.id) {
      return Response.json(
        { error: companyCreate.error || "Failed to create company." },
        { status: 400 },
      );
    }

    const shopifyCompanyId = companyCreate.company.id;
    const locationCreateRes = await admin.graphql(
      `#graphql
      mutation CreateCompanyLocation($companyId: ID!, $input: CompanyLocationInput!) {
        companyLocationCreate(companyId: $companyId, input: $input) {
          companyLocation { id name }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          companyId: shopifyCompanyId,
          input: { name: locationName },
        },
      },
    );
    const locationCreateJson = await locationCreateRes.json();
    const locationErrors =
      locationCreateJson.data?.companyLocationCreate?.userErrors || [];
    const companyLocation =
      locationCreateJson.data?.companyLocationCreate?.companyLocation;

    if (
      locationCreateJson.errors?.length ||
      locationErrors.length ||
      !companyLocation?.id
    ) {
      return Response.json(
        {
          error:
            locationCreateJson.errors?.[0]?.message ||
            locationErrors[0]?.message ||
            "Failed to create company location.",
        },
        { status: 400 },
      );
    }

    if (countryCode && address1) {
      const addressRes = await admin.graphql(
        `#graphql
        mutation AssignAddress($locationId: ID!, $address: CompanyAddressInput!, $addressTypes: [CompanyAddressType!]!) {
          companyLocationAssignAddress(locationId: $locationId, address: $address, addressTypes: $addressTypes) {
            userErrors { field message }
          }
        }`,
        {
          variables: {
            locationId: companyLocation.id,
            address: {
              address1,
              address2,
              city,
              province: provinceCode,
              country: countryCode,
              zip,
              phone: formattedPhone,
              firstName,
              lastName,
              recipient: `${firstName} ${lastName}`.trim(),
            },
            addressTypes: ["SHIPPING", "BILLING"],
          },
        },
      );
      const addressJson = await addressRes.json();
      const addressErrors =
        addressJson.data?.companyLocationAssignAddress?.userErrors || [];

      if (addressJson.errors?.length || addressErrors.length) {
        return Response.json(
          {
            error: addressErrors[0]?.message || "Failed to assign location address.",
          },
          { status: 400 },
        );
      }
    }

    const assignment = await assignCompanyToCustomer(
      admin,
      customerId,
      shopifyCompanyId,
    );

    if (!assignment.success) {
      return Response.json(
        {
          error: `${assignment.step || "assignCustomer"}: ${assignment.error}`,
        },
        { status: 400 },
      );
    }

    const newCompany = await prisma.companyAccount.create({
      data: {
        shopId: store.id,
        shopifyCompanyId,
        name: companyName,
        contactName: `${firstName} ${lastName}`.trim(),
        contactEmail: customerEmail,
        creditLimit: store.defaultCompanyCreditLimit ?? new Prisma.Decimal(0),
        salesUsers: {
          create: { userId: user.id },
        },
      },
      select: { id: true },
    });

    const existingLocalUser = await prisma.user.findFirst({
      where: { email: customerEmail, shopId: store.id },
    });

    if (existingLocalUser) {
      await prisma.user.update({
        where: { id: existingLocalUser.id },
        data: {
          companyId: newCompany.id,
          shopifyCustomerId: customerId,
          firstName: firstName || existingLocalUser.firstName,
          lastName: lastName || existingLocalUser.lastName,
          status: "APPROVED",
        },
      });
    } else {
      await createUser({
        email: customerEmail,
        firstName,
        lastName,
        password: "",
        role: "STORE_USER",
        status: "APPROVED",
        shopId: store.id,
        companyId: newCompany.id,
        companyRole: "member",
        shopifyCustomerId: customerId,
        userCreditLimit: 0,
      });
    }

    return redirect(
      `/sales/portal/company/${newCompany.id}/orders?companyCreated=1`,
    );
  }

  if (intent === "delete_order") {
    const orderId = formData.get("orderId") as string;
    if (!orderId) {
      return Response.json({ error: "Missing order ID" }, { status: 400 });
    }

    const order = await prisma.b2BOrder.findFirst({
      where: { id: orderId, companyId },
      include: {
        company: {
          include: {
            shop: true,
          },
        },
      },
    });

    if (!order) {
      return Response.json({ error: "Order not found" }, { status: 404 });
    }

    try {
      const shop = order.company.shop;
      const admin = shop.accessToken
        ? await getAdminForShop(shop.shopDomain)
        : undefined;

      // 1. Restore company/user credit if the order has remaining balance and was not already cancelled
      if (
        order.orderStatus !== "cancelled" &&
        (order.paymentStatus === "pending" ||
          order.paymentStatus === "partial") &&
        order.remainingBalance.greaterThan(0)
      ) {
        console.log(
          `🏦 Restoring credit: ${order.remainingBalance} for deleted order ${order.id}`,
        );
        await restoreCredit(
          order.companyId,
          order.id,
          order.remainingBalance,
          user.id,
          "cancelled",
          admin as Parameters<typeof restoreCredit>[5],
        );
      }

      // 2. If it is a draft order, try to delete the draft in Shopify
      if (order.shopifyOrderId && admin) {
        const isDraft =
          !order.shopifyOrderId.startsWith("gid://shopify/Order/") &&
          (order.orderStatus === "draft" ||
            !order.shopifyOrderId.includes("/Order/"));

        if (isDraft) {
          const gid = order.shopifyOrderId.startsWith("gid://")
            ? order.shopifyOrderId
            : `gid://shopify/DraftOrder/${order.shopifyOrderId}`;

          console.log(`🗑️ Deleting Shopify Draft Order: ${gid}`);
          const mutation = `
            mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
              draftOrderDelete(input: $input) {
                deletedId
                userErrors {
                  field
                  message
                }
              }
            }
          `;
          try {
            const response = await admin.graphql(mutation, {
              variables: { input: { id: gid } },
            });
            const data = await response.json();
            const errors = data.data?.draftOrderDelete?.userErrors || [];
            if (errors.length > 0) {
              console.error("Shopify DraftOrder delete errors:", errors);
            }
          } catch (shopifyErr) {
            console.error(
              "Failed to delete draft order on Shopify:",
              shopifyErr,
            );
          }
        }
      }

      // 3. Delete related credit transactions and notifications safely to avoid foreign key/relation issues
      const orderIdentifiers = [
        order.id,
        order.shopifyOrderId,
        order.shopifyOrderId?.split("/").pop(),
      ].filter(Boolean) as string[];

      await prisma.creditTransaction.deleteMany({
        where: {
          companyId: order.companyId,
          orderId: { in: orderIdentifiers },
        },
      });

      if (order.shopifyOrderId) {
        const numericShopifyId = order.shopifyOrderId.split("/").pop();
        await prisma.notification.deleteMany({
          where: {
            shopifyOrderId: {
              in: [order.shopifyOrderId, numericShopifyId].filter(
                Boolean,
              ) as string[],
            },
          },
        });
      }

      // 4. Delete the B2BOrder itself (cascade deletes payments)
      await prisma.b2BOrder.delete({
        where: { id: order.id },
      });

      console.log(
        `✅ Successfully deleted order ${order.id} from local database`,
      );
      return Response.json({
        success: true,
        message: "Order deleted successfully",
      });
    } catch (err: unknown) {
      console.error("Error deleting order:", err);
      return Response.json(
        {
          error: `Failed to delete order: ${
            err instanceof Error ? err.message : "Unknown error"
          }`,
        },
        { status: 500 },
      );
    }
  }

  if (intent === "generate_payment_link") {
    const orderId = String(formData.get("orderId") || "");
    const order = await prisma.b2BOrder.findFirst({
      where: { id: orderId, companyId },
      include: { company: { include: { shop: true } } },
    });
    if (!order) {
      return Response.json({ error: "Order not found" }, { status: 404 });
    }
    try {
      const generated = await getOrCreateSalesOrderPaymentLink(order);
      await logOrderActivity({
        orderId: order.id,
        userId: user.id,
        action: generated.reused
          ? "Payment Link Reused"
          : "Payment Link Generated",
        message: generated.link,
      });
      return Response.json({
        success: true,
        message: generated.reused
          ? "Existing active payment link reused."
          : "Payment link generated.",
      });
    } catch (error) {
      console.error("[sales-payment-link] Generation failed", {
        orderId: order.id,
        companyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Payment link generation failed.",
        },
        { status: 400 },
      );
    }
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
};

export default function OrderManageScreen() {
  const [isCreateCompanyOpen, setIsCreateCompanyOpen] = useState(false);
  const [countryOptions, setCountryOptions] = useState<
    CreateCompanyCountryOption[]
  >([]);
  const [selectedCountryCode, setSelectedCountryCode] = useState("US");
  const [selectedProvinceCode, setSelectedProvinceCode] = useState("");
  // NEW: controls whether the toast is currently visible (manual dismiss)
  const [toastDismissed, setToastDismissed] = useState(false);

  const {
    user,
    company,
    orders,
    quoteCount,
    allCompanies,
    selectedCompanyId,
    createOrderCompanyId,
  } = useLoaderData<{
    user: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string;
    };
    company: {
      id: string;
      name: string;
      creditLimit: string;
      themeColor: string | null;
      storeName: string | null;
    };
    orders: Array<{
      id: string;
      shopifyOrderId: string | null;
      orderNumber: string;
      shopifyOrderName: string | null;
      orderTotal: string;
      paymentStatus: string;
      orderStatus: string;
      createdAt: string;
      remainingBalance: string;
      currencyCode: string;
      customerName: string | null;
      customerEmail: string | null;
      source: string | null;
      paymentLink: string | null;
      paymentLinkToken: string | null;
      canGeneratePaymentLink: boolean;
      companyName: string | null;
      itemCount: number;
      quantity: number;
      createdByUser: {
        firstName: string | null;
        lastName: string | null;
        email: string;
      } | null;
    }>;
    createOrderCompanyId: string;
    quoteCount: number;
    allCompanies: Array<{ id: string; name: string }>;
    selectedCompanyId: string;
  }>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const actionData = useActionData<{
    success?: boolean;
    error?: string;
    message?: string;
  }>();
  const successToastMessage = searchParams.get("companyCreated")
    ? "Company created successfully."
    : searchParams.get("companyLinked")
      ? "Company already existed and was linked successfully."
      : actionData?.success
        ? actionData.message || "Action completed successfully."
        : "";
  const errorToastMessage = actionData?.error || "";
  const toastTimerRef = useRef<number | null>(null);
  const isDeleting =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "delete_order";
  const generatingOrderId =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "generate_payment_link"
      ? String(navigation.formData.get("orderId"))
      : null;
  const isCreatingCompany =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "createCompany";

  // FIX #1: Close the "Create Company" modal once the create/link succeeds.
  // The action does a redirect to the same route, so React Router keeps this
  // component mounted and isCreateCompanyOpen would otherwise stay true forever.
  useEffect(() => {
    if (
      searchParams.get("companyCreated") ||
      searchParams.get("companyLinked")
    ) {
      setIsCreateCompanyOpen(false);
    }
  }, [searchParams]);

  // FIX #2: Reset the dismiss flag whenever a *new* toast message appears,
  // so previously-closed toasts don't stay hidden and new ones show + can be closed.
  useEffect(() => {
    if (successToastMessage || errorToastMessage) {
      setToastDismissed(false);
    }
  }, [successToastMessage, errorToastMessage]);

  useEffect(() => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    if (successToastMessage) {
      toastTimerRef.current = window.setTimeout(() => {
        setToastDismissed(true);
      }, 4000);
    }
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [successToastMessage]);

  useEffect(() => {
    let isActive = true;

    fetch("/api/proxy/shipping-zones")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to load shipping zones");
        }
        return response.json();
      })
      .then((data) => {
        if (!isActive) return;
        const nextCountries: CreateCompanyCountryOption[] = Array.isArray(
          data?.countries,
        )
          ? data.countries
          : [];
        setCountryOptions(nextCountries);
        if (nextCountries.length > 0) {
          const hasUs = nextCountries.some((country) => country.value === "US");
          if (!hasUs) {
            setSelectedCountryCode(nextCountries[0].value);
          }
        }
      })
      .catch(() => {
        if (!isActive) return;
        setCountryOptions([]);
      });

    return () => {
      isActive = false;
    };
  }, []);

  const selectedCountry = countryOptions.find(
    (country) => country.value === selectedCountryCode,
  );
  const provinceOptions = selectedCountry?.provinces ?? [];
  const selectedDialCode =
    selectedCountry?.dialCode ||
    getDialCodeForCountry(selectedCountryCode) ||
    "+";

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));

  const formatCurrency = (val: string | number, currencyCode: string) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(Number(val) || 0);

  const getStatusBadge = (status: string) => {
    const map: Record<string, { bg: string; color: string }> = {
      paid: { bg: "#dcfce7", color: "#166534" },
      pending: { bg: "#fef9c3", color: "#854d0e" },
      partial: { bg: "#e0f2fe", color: "#075985" },
      cancelled: { bg: "#fce4ec", color: "#b71c1c" },
      fulfilled: { bg: "#dcfce7", color: "#166534" },
      unfulfilled: { bg: "#fef9c3", color: "#854d0e" },
      draft: { bg: "#f3e8ff", color: "#6b21a8" },
      completed: { bg: "#dbeafe", color: "#1e40af" },
      submitted: { bg: "#e0f2fe", color: "#0369a1" },
    };
    const s = map[status?.toLowerCase()] || { bg: "#f3f4f6", color: "#374151" };
    return (
      <span
        style={{
          padding: "4px 10px",
          borderRadius: "20px",
          fontSize: "12px",
          fontWeight: 600,
          backgroundColor: s.bg,
          color: s.color,
          textTransform: "capitalize",
        }}
      >
        {status || "N/A"}
      </span>
    );
  };

  return (
    <SalesPortalLayout
      company={
        selectedCompanyId === "all"
          ? { ...allCompanies[0], creditLimit: "0", themeColor: null, storeName: null }
          : company
      }
      user={user}
      activePage="orders"
      orderCount={orders.length}
      quoteCount={quoteCount}
      themeColor={company.themeColor}
    >
      {successToastMessage && !toastDismissed ? (
        <div style={styles.successToast}>
          <span>{successToastMessage}</span>
          <button
            type="button"
            aria-label="Dismiss"
            style={styles.toastCloseBtn}
            onClick={() => setToastDismissed(true)}
          >
            ×
          </button>
        </div>
      ) : null}
      {errorToastMessage && !toastDismissed ? (
        <div style={styles.errorToast}>
          <span>{errorToastMessage}</span>
          <button
            type="button"
            aria-label="Dismiss"
            style={styles.toastCloseBtn}
            onClick={() => setToastDismissed(true)}
          >
            ×
          </button>
        </div>
      ) : null}

      <SalesPortalHeader
        title="Manage Orders"
        subtitle={
          selectedCompanyId === "all"
            ? "List, review, and manage B2B orders across all companies."
            : `List, review, and manage B2B orders for ${company.name}.`
        }
        companyId={selectedCompanyId}
        companies={allCompanies}
        companySwitchPath="/sales/portal/orders?company="
        actions={
          <>
            <button
              type="button"
              style={salesPortalButtonStyles.secondary}
              onClick={() => setIsCreateCompanyOpen(true)}
            >
              + Create Company
            </button>
            <Link
              to={createOrderCompanyId ? `/sales/portal/company/${createOrderCompanyId}/create-order` : "/sales/portal"}
              style={salesPortalButtonStyles.primary}
            >
              + Create Order
            </Link>
            <Link
              to={`/sales/portal/company/${selectedCompanyId === "all" ? allCompanies[0]?.id : company.id}/create-quote`}
              style={salesPortalButtonStyles.secondary}
            >
              + Create Quote
            </Link>
          </>
        }
      />

      {isCreateCompanyOpen && (
        <div style={styles.modalBackdrop}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <div>
                <h2 style={styles.modalTitle}>Create Company</h2>
                <p style={styles.modalSubtitle}>
                  Add a company, location, and main contact.
                </p>
              </div>
              <button
                type="button"
                style={styles.closeBtn}
                onClick={() => setIsCreateCompanyOpen(false)}
                aria-label="Close create company modal"
              >
                ×
              </button>
            </div>

            <Form method="post" style={styles.companyForm}>
              <input type="hidden" name="intent" value="createCompany" />

              <section style={styles.formSection}>
                <h3 style={styles.sectionTitle}>Company</h3>
                <label style={styles.fieldLabel}>
                  Company name
                  <input name="companyName" required style={styles.input} />
                </label>
              </section>

              <section style={styles.formSection}>
                <h3 style={styles.sectionTitle}>Location</h3>
                <label style={styles.fieldLabel}>
                  Location name
                  <input name="locationName" style={styles.input} />
                </label>
                <label style={styles.fieldLabel}>
                  Address line 1
                  <input name="address1" style={styles.input} />
                </label>
                <label style={styles.fieldLabel}>
                  Address line 2
                  <input name="address2" style={styles.input} />
                </label>
                <div style={styles.formGrid}>
                  <label style={styles.fieldLabel}>
                    Country
                    <select
                      name="countryCode"
                      value={selectedCountryCode}
                      onChange={(event) => {
                        setSelectedCountryCode(event.target.value);
                        setSelectedProvinceCode("");
                      }}
                      style={{ ...styles.input, appearance: "none" as const }}
                    >
                      <option value="">Select country</option>
                      {countryOptions.map((country) => (
                        <option key={country.value} value={country.value}>
                          {country.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={styles.fieldLabel}>
                    State / Province
                    {provinceOptions.length > 0 ? (
                      <select
                        name="provinceCode"
                        value={selectedProvinceCode}
                        onChange={(event) =>
                          setSelectedProvinceCode(event.target.value)
                        }
                        style={{ ...styles.input, appearance: "none" as const }}
                      >
                        <option value="">Select state / province</option>
                        {provinceOptions.map((province) => (
                          <option key={province.value} value={province.value}>
                            {province.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        name="provinceCode"
                        placeholder="CA"
                        value={selectedProvinceCode}
                        onChange={(event) =>
                          setSelectedProvinceCode(event.target.value)
                        }
                        style={styles.input}
                      />
                    )}
                  </label>
                </div>
                <div style={styles.formGrid}>
                  <label style={styles.fieldLabel}>
                    City
                    <input name="city" style={styles.input} />
                  </label>
                  <label style={styles.fieldLabel}>
                    ZIP / Postal code
                    <input name="zip" style={styles.input} />
                  </label>
                </div>
              </section>

              <section style={styles.formSection}>
                <h3 style={styles.sectionTitle}>Main contact</h3>
                <div style={styles.formGrid}>
                  <label style={styles.fieldLabel}>
                    First name
                    <input name="firstName" required style={styles.input} />
                  </label>
                  <label style={styles.fieldLabel}>
                    Last name
                    <input name="lastName" required style={styles.input} />
                  </label>
                </div>
                <div style={styles.formGrid}>
                  <label style={styles.fieldLabel}>
                    Email
                    <input
                      name="customerEmail"
                      type="email"
                      required
                      style={styles.input}
                    />
                  </label>
                  <label style={styles.fieldLabel}>
                    Phone (optional)
                    <div style={{ display: "flex", gap: "8px" }}>
                      <span
                        style={{
                          ...styles.input,
                          width: "84px",
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#4b5563",
                          backgroundColor: "#f9fafb",
                        }}
                      >
                        {selectedDialCode}
                      </span>
                      <input
                        name="phone"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="9876543210"
                        style={{ ...styles.input, flex: 1 }}
                      />
                    </div>
                  </label>
                </div>
              </section>

              <div style={styles.modalActions}>
                <button
                  type="button"
                  style={styles.cancelBtn}
                  onClick={() => setIsCreateCompanyOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={styles.primaryBtn}
                  disabled={isCreatingCompany}
                >
                  {isCreatingCompany ? "Creating..." : "Create Company"}
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Orders Table Card */}
      <div style={styles.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={styles.cardTitle}>
            {selectedCompanyId === "all" ? "All B2B Orders" : `B2B Orders — ${company.name}`}
          </h2>
          {allCompanies.length > 1 && (
            <Form method="get" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                name="company"
                defaultValue={selectedCompanyId}
                style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13 }}
              >
                <option value="all">All companies</option>
                {allCompanies.map((c: any) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button
                type="submit"
                style={{ padding: "6px 14px", fontSize: 13, borderRadius: 6, border: "1px solid var(--sales-portal-accent-tint)", background: "var(--sales-portal-accent-lighter)", cursor: "pointer" }}
              >
                Filter
              </button>
            </Form>
          )}
        </div>
        {orders.length > 0 ? (
          <div className="sales-quote-table-wrap" style={styles.tableContainer}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Order ID</th>
                  <th style={styles.th}>Order Number</th>
                  <th style={styles.th}>Shopify Order</th>
                  <th style={styles.th}>Customer</th>
                  {selectedCompanyId === "all" && <th style={styles.th}>Company</th>}
                  <th style={styles.th}>Created By</th>
                  <th style={styles.th}>Date</th>
                  <th style={styles.th}>Items</th>
                  <th style={styles.th}>Quantity</th>
                  <th style={styles.th}>Total</th>
                  <th style={styles.th}>Payment Status</th>
                  <th style={styles.th}>Order Status</th>
                  <th style={{ ...styles.th, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const isOrderDeleting =
                    isDeleting &&
                    navigation.formData?.get("orderId") === order.id;
                  const canDelete =
                    order.orderStatus !== "shipped" &&
                    order.orderStatus !== "delivered";
                  const { canGeneratePaymentLink } = order;

                  return (
                    <tr key={order.id} style={styles.tr}>
                      <td style={styles.td}>
                        <span style={styles.orderIdBadge}>
                          {order.id.slice(-8).toUpperCase()}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <strong style={{ color: "#2c6ecb" }}>
                          {order.orderNumber}
                        </strong>
                      </td>
                      <td style={styles.td}>
                        <span style={{ fontSize: 13, color: "#374151" }}>
                          {order.shopifyOrderName ||
                            (order.shopifyOrderId
                              ? `#${order.shopifyOrderId.split("/").pop()}`
                              : "N/A")}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <span style={{ fontSize: 13, color: "#374151" }}>
                          {order.customerName || order.customerEmail || "—"}
                        </span>
                      </td>
                      {selectedCompanyId === "all" && (
                        <td style={styles.td}>
                          <span style={{ fontSize: 13, color: "#374151" }}>
                            {order.companyName || "—"}
                          </span>
                        </td>
                      )}
                      <td style={styles.td}>
                        {order.createdByUser
                          ? `${order.createdByUser.firstName} ${order.createdByUser.lastName}`
                          : "System"}
                      </td>
                      <td style={styles.td}>{formatDate(order.createdAt)}</td>
                      <td style={styles.td}>{order.itemCount}</td>
                      <td style={styles.td}>{order.quantity}</td>
                      <td style={styles.td}>
                        <strong>
                          {formatCurrency(order.orderTotal, order.currencyCode)}
                        </strong>
                      </td>
                      <td style={styles.td}>
                        {getStatusBadge(order.paymentStatus)}
                      </td>
                      <td style={styles.td}>
                        {getStatusBadge(order.orderStatus)}
                      </td>
                      <td style={{ ...styles.td, textAlign: "right" }}>
                        {canGeneratePaymentLink &&
                          (order.paymentLink &&
                          !order.paymentLinkToken &&
                          !order.paymentLink.includes("/account/orders/") ? (
                            <a
                              href={order.paymentLink}
                              target="_blank"
                              rel="noreferrer"
                              style={styles.paymentLinkBtn}
                            >
                              Open Payment Checkout
                            </a>
                          ) : (
                            <Form method="post" style={{ display: "inline" }}>
                              <input
                                type="hidden"
                                name="intent"
                                value="generate_payment_link"
                              />
                              <input
                                type="hidden"
                                name="orderId"
                                value={order.id}
                              />
                              <button
                                type="submit"
                                disabled={generatingOrderId === order.id}
                                style={styles.paymentLinkBtn}
                              >
                                {generatingOrderId === order.id
                                  ? "Generating..."
                                  : "Generate Payment Link"}
                              </button>
                            </Form>
                          ))}
                        {canDelete ? (
                          <Form
                            method="post"
                            style={{ display: "inline" }}
                            onSubmit={(e) => {
                              if (
                                !confirm(
                                  "Are you sure you want to delete this order? This will restore company credit and remove the order record permanently.",
                                )
                              ) {
                                e.preventDefault();
                              }
                            }}
                          >
                            <input
                              type="hidden"
                              name="intent"
                              value="delete_order"
                            />
                            <input
                              type="hidden"
                              name="orderId"
                              value={order.id}
                            />
                            <button
                              type="submit"
                              disabled={isOrderDeleting}
                              style={{
                                ...styles.deleteBtn,
                                opacity: isOrderDeleting ? 0.6 : 1,
                              }}
                            >
                              {isOrderDeleting ? "Deleting..." : "🗑️ Delete"}
                            </button>
                          </Form>
                        ) : (
                          <span style={{ fontSize: "12px", color: "#8c9196" }}>
                            Non-deletable
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={styles.emptyState}>
            <span style={{ fontSize: "48px", marginBottom: "16px" }}>📦</span>
            <p style={{ margin: 0, fontWeight: 500, fontSize: "16px" }}>
              No orders found.
            </p>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: "13px",
                color: "#9ca3af",
              }}
            >
              There are no orders logged for this company yet.
            </p>
          </div>
        )}
      </div>
    </SalesPortalLayout>
  );
}

const styles = {
  card: {
    backgroundColor: "white",
    borderRadius: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
    border: "1px solid #eaeaea",
    padding: "24px",
  },
  cardTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "17px",
    fontWeight: 600,
    color: "#111",
    margin: "0 0 20px 0",
  },
  tableContainer: { overflowX: "auto" as const },
  table: { width: "100%", borderCollapse: "collapse" as const },
  th: {
    textAlign: "left" as const,
    padding: "12px 14px",
    borderBottom: "1px solid #eaeaea",
    color: "#5c5f62",
    fontWeight: 600,
    fontSize: "13px",
    whiteSpace: "nowrap" as const,
  },
  tr: { borderBottom: "1px solid #f5f5f5" },
  td: { padding: "14px 14px", fontSize: "14px", color: "#202223" },
  orderIdBadge: {
    backgroundColor: "#f3f4f6",
    padding: "4px 8px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 500,
    color: "#4b5563",
    fontFamily: "monospace",
  },
  deleteBtn: {
    backgroundColor: "#fee2e2",
    color: "#991b1b",
    border: "none",
    padding: "6px 12px",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "background-color 0.2s",
  },
  paymentLinkBtn: {
    display: "inline-block",
    marginRight: "8px",
    padding: "7px 10px",
    border: "1px solid var(--sales-portal-accent)",
    borderRadius: "6px",
    background: "var(--sales-portal-accent-lighter)",
    color: "var(--sales-portal-accent)",
    fontSize: "12px",
    fontWeight: 600,
    textDecoration: "none",
    cursor: "pointer",
  },
  successToast: {
    position: "fixed" as const,
    top: "20px",
    right: "20px",
    zIndex: 1200,
    maxWidth: "420px",
    padding: "14px 16px",
    backgroundColor: "#ecfdf5",
    color: "#065f46",
    border: "1px solid #a7f3d0",
    borderRadius: "8px",
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.16)",
    fontSize: "14px",
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  errorToast: {
    position: "fixed" as const,
    top: "20px",
    right: "20px",
    zIndex: 1200,
    maxWidth: "420px",
    padding: "14px 16px",
    backgroundColor: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
    borderRadius: "8px",
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.16)",
    fontSize: "14px",
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  toastCloseBtn: {
    background: "none",
    border: "none",
    fontSize: "18px",
    lineHeight: 1,
    cursor: "pointer",
    color: "inherit",
    padding: "0 0 0 8px",
    flexShrink: 0,
  },
  modalBackdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1000,
    backgroundColor: "rgba(17, 24, 39, 0.48)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px",
  },
  modal: {
    width: "100%",
    maxWidth: "760px",
    maxHeight: "90vh",
    overflowY: "auto" as const,
    backgroundColor: "white",
    borderRadius: "12px",
    boxShadow: "0 24px 60px rgba(15, 23, 42, 0.24)",
    border: "1px solid #e5e7eb",
    padding: "24px",
  },
  modalHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "20px",
    marginBottom: "20px",
  },
  modalTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "22px",
    fontWeight: 700,
    color: "#111827",
    margin: 0,
  },
  modalSubtitle: {
    color: "#6b7280",
    fontSize: "14px",
    margin: "6px 0 0",
  },
  closeBtn: {
    width: "36px",
    height: "36px",
    borderRadius: "8px",
    border: "1px solid var(--sales-portal-accent-tint)",
    backgroundColor: "var(--sales-portal-accent-lighter)",
    color: "var(--sales-portal-accent-dark)",
    fontSize: "24px",
    lineHeight: 1,
    cursor: "pointer",
  },
  companyForm: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "18px",
  },
  formSection: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "12px",
    paddingTop: "16px",
    borderTop: "1px solid #eef2f7",
  },
  sectionTitle: {
    fontFamily: "'Poppins', sans-serif",
    color: "#111827",
    fontSize: "15px",
    fontWeight: 700,
    margin: 0,
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "12px",
  },
  fieldLabel: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
    color: "#374151",
    fontSize: "13px",
    fontWeight: 600,
  },
  input: {
    width: "100%",
    boxSizing: "border-box" as const,
    border: "1px solid #d1d5db",
    borderRadius: "8px",
    padding: "11px 12px",
    fontSize: "14px",
    color: "#111827",
    outline: "none",
  },
  modalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "10px",
    paddingTop: "4px",
  },
  cancelBtn: {
    padding: "11px 18px",
    border: "1px solid var(--sales-portal-accent-tint)",
    borderRadius: "8px",
    backgroundColor: "var(--sales-portal-accent-lighter)",
    color: "var(--sales-portal-accent-dark)",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
  },
  primaryBtn: {
    padding: "11px 18px",
    border: "none",
    borderRadius: "8px",
    backgroundColor: "var(--sales-portal-accent)",
    color: "var(--sales-portal-accent-contrast)",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "48px",
    color: "#5c5f62",
    textAlign: "center" as const,
  },
};