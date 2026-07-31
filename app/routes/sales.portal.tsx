import {
  redirect,
  useLoaderData,
  Link,
  Form,
  useActionData,
  useNavigation,
  useSearchParams,
} from "react-router";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Prisma } from "@prisma/client";
import prisma from "app/db.server";
import { getAdminForShop } from "app/shopify.server";
import {
  requireSalesSession,
  hasCompanyAccess,
  buildClearSessionCookie,
} from "app/utils/sales-session.server";
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
  getOrderAccessWhere,
  getOrderNumber,
  getShopifyOrderWhere,
} from "app/services/sales-order-management.server";
import { getCreditSummary } from "app/services/creditService";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);

  const url = new URL(request.url);
  let companyId = url.searchParams.get("companyId");

  if (companyId === "all") {
    return redirect("/sales/portal/orders?company=all");
  }

  if (!companyId && user.salesCompanies.length > 0) {
    companyId = user.salesCompanies[0].companyId;
  }

  // If no company is available, return a dashboard with no company
  if (!companyId) {
    return Response.json({
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      },
      company: null,
      recentOrders: [],
      orderCount: 0,
      quoteCount: 0,
      allCompanies: user.salesCompanies.map((sc) => ({
        id: sc.company.id,
        name: sc.company.name,
      })),
    });
  }

  if (!hasCompanyAccess(user, companyId)) {
    throw new Response("You do not have access to this company.", {
      status: 403,
    });
  }

  // Get full company data
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    include: {
      shop: {
        select: {
          shopName: true,
          shopDomain: true,
          themeColor: true,
          accessToken: true,
          currencyCode: true,
          plan: true,
        },
      },
    },
  });

  if (!company) {
    throw new Response("Company not found.", {
      status: 404,
    });
  }

  // Fetch real-time users directly from Shopify (fixes the issue where Shopify users aren't synced locally)
  let activeUsers: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    companyRole: string | null;
  }> = [];
  type ShopifyCompanyCustomer = {
    customer: {
      id: string;
      email: string;
      firstName?: string | null;
      lastName?: string | null;
      roleAssignments?: {
        edges?: Array<{
          node?: { role?: { name?: string | null } | null } | null;
        }>;
      } | null;
    };
  };

  if (company.shopifyCompanyId && company.shop.accessToken) {
    const { getCompanyCustomers } =
      await import("app/utils/b2b-customer.server");
    const customersData = await getCompanyCustomers(
      company.shopifyCompanyId,
      company.shop.shopDomain,
      company.shop.accessToken,
      { first: 50 },
    );

    if (!customersData.error && customersData.customers) {
      activeUsers = customersData.customers
        .map((c: ShopifyCompanyCustomer) => {
          const firstName = c.customer.firstName?.trim() || null;
          const lastName = c.customer.lastName?.trim() || null;
          const companyRole =
            c.customer.roleAssignments?.edges?.[0]?.node?.role?.name ||
            "Ordering only";
          const customerId = c.customer.id.split("/").pop();

          return {
            id: customerId,
            email: c.customer.email,
            firstName,
            lastName,
            companyRole,
          };
        })
        .filter(
          (u: { companyRole: string | null }) =>
            u.companyRole?.toLowerCase() === "location admin",
        );
    }
  }

  // Get recent orders for this company using the same access rules as the orders page
  const recentOrderWhere: Prisma.B2BOrderWhereInput = {
    AND: [
      getOrderAccessWhere(user),
      getShopifyOrderWhere(),
      { companyId: company.id },
    ],
  };
  const recentOrders = await prisma.b2BOrder.findMany({
    where: recentOrderWhere,
    orderBy: { createdAt: "desc" },
    take: 15,
    include: {
      company: { select: { id: true, name: true } },
      createdByUser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      items: { select: { quantity: true } },
    },
  });

  const orderCount = await prisma.b2BOrder.count({
    where: recentOrderWhere,
  });

  const quoteCount = await prisma.quote.count({
    where: { companyId: company.id },
  });

  const creditSummary = await getCreditSummary(company.id);

  if (!creditSummary) {
    throw new Response("Unable to fetch credit summary", { status: 500 });
  }

  const isFreePlan = company.shop.plan === "free";
  const creditLimit = isFreePlan ? 0 : creditSummary.creditLimit.toNumber();
  const usedCredit = isFreePlan ? 0 : creditSummary.usedCredit.toNumber();
  const availableCredit = isFreePlan
    ? 0
    : Math.max(0, creditSummary.availableCredit.toNumber());

  const allCompanies = user.salesCompanies.map((sc) => ({
    id: sc.company.id,
    name: sc.company.name,
  }));
  const companies =
    allCompanies.length > 1
      ? [{ id: "all", name: "All companies" }, ...allCompanies]
      : allCompanies;

  return Response.json({
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    company: {
      ...company,
      creditLimit: creditLimit.toString(),
      usedCredit: usedCredit.toString(),
      availableCredit: availableCredit.toString(),
      themeColor: company.shop.themeColor ?? null,
      storeName: company.shop.shopName || company.shop.shopDomain,
      currencyCode: company.shop.currencyCode || "USD",
      users: activeUsers,
    },
    recentOrders: recentOrders.map((o) => ({
      id: o.id,
      orderNumber: getOrderNumber(o),
      customerName: o.customerName,
      customerEmail: o.customerEmail,
      company: o.company,
      salesAgent: o.createdByUser,
      itemCount: o.items.length,
      quantity: o.items.reduce((sum, item) => sum + item.quantity, 0),
      orderTotal: o.orderTotal?.toString() || "0",
      currencyCode: o.currencyCode,
      paymentStatus: o.paymentStatus,
      orderStatus: o.orderStatus,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    })),
    orderCount,
    quoteCount,
    allCompanies: companies,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { user } = await requireSalesSession(request);
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
        `/sales/portal?companyId=${existingCompany.id}&companyLinked=1`,
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
              zoneCode: provinceCode,
              countryCode,
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
            error:
              addressJson.errors?.[0]?.message ||
              addressErrors[0]?.message ||
              "Failed to assign location address.",
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

    const company = await prisma.companyAccount.create({
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
          companyId: company.id,
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
        companyId: company.id,
        companyRole: "member",
        shopifyCustomerId: customerId,
        userCreditLimit: 0,
      });
    }

    return redirect(`/sales/portal?companyId=${company.id}&companyCreated=1`);
  }

  return Response.json({ error: "Unknown intent" });
};

export default function SalesPortal() {
  const [isCreateCompanyOpen, setIsCreateCompanyOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [countryOptions, setCountryOptions] = useState<
    CreateCompanyCountryOption[]
  >([]);
  const [selectedCountryCode, setSelectedCountryCode] = useState("US");
  const [selectedProvinceCode, setSelectedProvinceCode] = useState("");
  const { user, company, recentOrders, orderCount, quoteCount, allCompanies } =
    useLoaderData<{
      user: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string;
      };
      company: {
        id: string;
        name: string;
        contactEmail: string | null;
        creditLimit: string;
        usedCredit: string;
        availableCredit: string;
        currencyCode: string;
        storeName: string | null;
        users: Array<{
          id: string;
          email: string;
          firstName: string | null;
          lastName: string | null;
          companyRole: string | null;
        }>;
        themeColor: string | null;
      } | null;
      recentOrders: Array<{
        id: string;
        orderNumber: string;
        orderTotal: string;
        currencyCode: string;
        paymentStatus: string;
        orderStatus: string;
        createdAt: string;
      }>;
      orderCount: number;
      quoteCount: number;
      allCompanies: Array<{ id: string; name: string }>;
    }>();
  const actionData = useActionData<{ error?: string }>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const successToastMessage = searchParams.get("companyCreated")
    ? "Company created successfully."
    : searchParams.get("companyLinked")
      ? "Company already existed and was linked successfully."
      : "";
  const errorToastMessage = actionData?.error || "";
  const hasSuccessRedirect = Boolean(
    searchParams.get("companyCreated") || searchParams.get("companyLinked"),
  );

  useEffect(() => {
    if (hasSuccessRedirect || company?.id) {
      setIsCreateCompanyOpen(false);
    }
  }, [company?.id, hasSuccessRedirect]);

  useEffect(() => {
    if (successToastMessage || errorToastMessage) {
      setToastMessage({
        type: successToastMessage ? "success" : "error",
        message: successToastMessage || errorToastMessage,
      });

      const timeout = window.setTimeout(() => {
        setToastMessage(null);
      }, 4000);

      return () => window.clearTimeout(timeout);
    }

    setToastMessage(null);
  }, [successToastMessage, errorToastMessage]);

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
          const hasSelection = nextCountries.some((country) => country.value === "US");
          if (!hasSelection) {
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
  const isCreatingCompany =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "createCompany";

  // If no company assigned, show empty state
  if (!company) {
    return (
      <div style={styles.container}>
        {toastMessage?.type === "success" ? (
          <div style={styles.successToast}>{toastMessage.message}</div>
        ) : null}
        {toastMessage?.type === "error" ? (
          <div style={styles.errorToast}>{toastMessage.message}</div>
        ) : null}
        <div style={styles.onboardingCard}>
          <div style={styles.onboardingHeader}>
            <div>
              <h2 style={styles.emptyStateTitle}>
                Welcome, {user.firstName || "Sales Agent"}!
              </h2>
              <p style={styles.emptyStateMessage}>
                Create your first company to open the sales portal.
              </p>
            </div>
            <Form method="post">
              <input type="hidden" name="intent" value="logout" />
              <button type="submit" style={styles.logoutBtn}>
                Sign Out
              </button>
            </Form>
          </div>

          {actionData?.error ? (
            <div style={styles.formError}>{actionData.error}</div>
          ) : null}

          <Form method="post" style={styles.onboardingForm}>
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
                      onChange={(event) => setSelectedProvinceCode(event.target.value)}
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
                      onChange={(event) => setSelectedProvinceCode(event.target.value)}
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
              <h3 style={styles.sectionTitle}>Main customer</h3>
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

            <button
              type="submit"
              style={styles.primaryBtn}
              disabled={isCreatingCompany}
            >
              {isCreatingCompany ? "Creating company..." : "Create company"}
            </button>
          </Form>
        </div>
      </div>
    );
  }

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));

  const formatCurrency = (val: string | number, currency = "USD") =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
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
          textTransform: "capitalize" as const,
        }}
      >
        {status || "N/A"}
      </span>
    );
  };

  const creditPercent =
    Number(company.creditLimit) > 0
      ? Math.min(
          100,
          (Number(company.usedCredit) / Number(company.creditLimit)) * 100,
        )
      : 0;
  const createOrderCompanyId = company.id || allCompanies[0]?.id || "";

  return (
    <SalesPortalLayout
      company={company}
      user={user}
      activePage="overview"
      orderCount={orderCount}
      quoteCount={quoteCount}
      themeColor={company.themeColor}
    >
      <div id="overview">
        {toastMessage?.type === "success" ? (
          <div style={styles.successToast}>{toastMessage.message}</div>
        ) : null}
        {toastMessage?.type === "error" ? (
          <div style={styles.errorToast}>{toastMessage.message}</div>
        ) : null}
        <SalesPortalHeader
          title={company.name}
          subtitle={`${company.contactEmail ? `Contact: ${company.contactEmail}` : "Sales Portal"} · ${company.users.length} customer(s) · ${company.storeName}`}
          companyId={company.id}
          companies={allCompanies}
          companySwitchPath="/sales/portal?companyId="
          allCompaniesPath="/sales/portal/orders?company="
          actions={
            <>
              <button
                type="button"
                style={salesPortalButtonStyles.secondary}
                onClick={() => setIsCreateCompanyOpen(true)}
              >
                <span>+</span> Create Company
              </button>
              <Link
                to={createOrderCompanyId ? `/sales/portal/company/${createOrderCompanyId}/create-order` : "/sales/portal"}
                style={salesPortalButtonStyles.primary}
              >
                <span>+</span> Create Order
              </Link>
              <Link
                to={`/sales/portal/company/${company.id}/create-quote`}
                style={salesPortalButtonStyles.secondary}
              >
                <span>+</span> Create Quote
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

              <Form method="post" style={styles.onboardingForm}>
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
                          onChange={(event) => setSelectedProvinceCode(event.target.value)}
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
                          onChange={(event) => setSelectedProvinceCode(event.target.value)}
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

        {actionData?.error ? (
          <div style={styles.formError}>{actionData.error}</div>
        ) : null}

        {/* Credit Limit Card */}
        <div style={styles.creditCard}>
          <div style={styles.creditHeader}>
            <h2 style={styles.creditTitle}>Company Credit</h2>
          </div>
          <div style={styles.creditBody}>
            <div
              className="sales-portal-credit-stats"
              style={styles.creditStatGroup}
            >
              <div style={styles.creditStat}>
                <span style={styles.creditStatLabel}>Credit Limit</span>
                <span style={styles.creditStatValue}>
                  {formatCurrency(company.creditLimit, company.currencyCode)}
                </span>
              </div>
              <div style={styles.creditStat}>
                <span style={styles.creditStatLabel}>Credit Used</span>
                <span style={styles.creditStatValue}>
                  {formatCurrency(company.usedCredit, company.currencyCode)}
                </span>
              </div>
              <div style={styles.creditStat}>
                <span style={styles.creditStatLabel}>Available Credit</span>
                <span style={styles.creditStatValue}>
                  {formatCurrency(
                    company.availableCredit,
                    company.currencyCode,
                  )}
                </span>
              </div>
            </div>
            <div style={styles.progressBarBg}>
              <div
                style={{
                  ...styles.progressBarFill,
                  width: `${creditPercent}%`,
                  backgroundColor: "var(--sales-portal-accent)",
                }}
              />
            </div>
            <div style={styles.progressLabel}>
              {creditPercent.toFixed(0)}% of limit utilized
            </div>
          </div>
        </div>

        {/* Two columns: Users + Recent Orders */}
        <div className="sales-portal-overview-grid" style={styles.twoColGrid}>
          {/* Company Users */}
          <div style={styles.card} id="users">
            <h2 style={styles.cardTitle}>Company Users</h2>
            {company.users.length > 0 ? (
              <div style={styles.tableContainer}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Name</th>
                      <th style={styles.th}>Email</th>
                      <th style={styles.th}>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {company.users.map((u) => (
                      <tr key={u.id} style={styles.tr}>
                        <td style={styles.td}>
                          <strong>
                            {u.firstName} {u.lastName}
                          </strong>
                        </td>
                        <td style={styles.td}>{u.email}</td>
                        <td style={styles.td}>
                          <span style={styles.roleBadge}>
                            {u.companyRole || "User"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={styles.emptyState}>
                <span style={{ fontSize: "32px" }}>👥</span>
                <p>No active users in this company.</p>
              </div>
            )}
          </div>

          {/* Recent Orders */}
          <div style={styles.card} id="orders">
            <h2 style={styles.cardTitle}>Recent Orders</h2>
            {recentOrders.length > 0 ? (
              <div style={styles.tableContainer}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Order</th>
                      <th style={styles.th}>Date</th>
                      <th style={styles.th}>Total</th>
                      <th style={styles.th}>Payment</th>
                      {/* <th style={styles.th}>Order Status</th> */}
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.map((order) => (
                      <tr key={order.id} style={styles.tr}>
                        <td style={styles.td}>
                          <strong
                            style={{ color: "var(--sales-portal-accent)" }}
                          >
                            {order.orderNumber}
                          </strong>
                        </td>
                        <td style={styles.td}>{formatDate(order.createdAt)}</td>
                        <td style={styles.td}>
                          {formatCurrency(order.orderTotal, order.currencyCode)}
                        </td>
                        <td style={styles.td}>
                          {getStatusBadge(order.paymentStatus)}
                        </td>
                        {/* <td style={styles.td}>
                          {getStatusBadge(order.orderStatus)}
                        </td> */}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={styles.emptyState}>
                <span style={{ fontSize: "32px" }}>📦</span>
                <p>No orders found for this company.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </SalesPortalLayout>
  );
}

const styles = {
  // Credit card styles
  creditCard: {
    backgroundColor: "white",
    borderRadius: "20px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.03)",
    border: "1px solid #eaeaea",
    marginBottom: "28px",
    overflow: "hidden",
  },
  creditHeader: {
    padding: "20px 24px 0",
  },
  creditTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "17px",
    fontWeight: 600,
    color: "#111",
    margin: 0,
  },
  creditBody: {
    padding: "20px 24px 24px",
  },
  creditStatGroup: {
    display: "flex",
    gap: "40px",
    marginBottom: "20px",
  },
  creditStat: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  },
  creditStatLabel: {
    fontSize: "13px",
    color: "#8c9196",
    fontWeight: 500,
  },
  creditStatValue: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "24px",
    fontWeight: 700,
    color: "#111",
    lineHeight: 1,
  },
  progressBarBg: {
    width: "100%",
    height: "8px",
    backgroundColor: "var(--sales-portal-accent-soft)",
    borderRadius: "4px",
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    borderRadius: "4px",
    transition: "width 0.5s ease",
  },
  progressLabel: {
    fontSize: "12px",
    color: "#8c9196",
    marginTop: "8px",
    fontWeight: 500,
  },
  // Layout
  twoColGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1.5fr",
    gap: "24px",
  },
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
    padding: "10px 14px",
    borderBottom: "1px solid #eaeaea",
    color: "#5c5f62",
    fontWeight: 500,
    fontSize: "13px",
    whiteSpace: "nowrap" as const,
  },
  tr: { borderBottom: "1px solid #f5f5f5" },
  td: { padding: "12px 14px", fontSize: "14px", color: "#202223" },
  roleBadge: {
    backgroundColor: "#f4f6f8",
    padding: "4px 10px",
    borderRadius: "20px",
    fontSize: "12px",
    fontWeight: 600,
    color: "#6d7175",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "40px",
    color: "#5c5f62",
    textAlign: "center" as const,
    gap: "8px",
  },
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    backgroundColor: "#f9fafb",
    padding: "20px",
  },
  onboardingCard: {
    backgroundColor: "white",
    borderRadius: "12px",
    padding: "28px",
    width: "100%",
    maxWidth: "760px",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.07)",
    border: "1px solid #e5e7eb",
  },
  onboardingHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: "20px",
    alignItems: "flex-start",
    marginBottom: "24px",
  },
  onboardingForm: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "20px",
  },
  formSection: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "12px",
    paddingTop: "18px",
    borderTop: "1px solid #eef2f7",
  },
  sectionTitle: {
    fontSize: "15px",
    fontWeight: 700,
    color: "#111827",
    margin: 0,
    fontFamily: "'Poppins', sans-serif",
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
  primaryBtn: {
    alignSelf: "flex-start",
    padding: "12px 22px",
    backgroundColor: "var(--sales-portal-accent)",
    color: "var(--sales-portal-accent-contrast)",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
  },
  formError: {
    padding: "12px 14px",
    backgroundColor: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
    borderRadius: "8px",
    marginBottom: "18px",
    fontSize: "14px",
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
  modalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "10px",
    paddingTop: "4px",
  },
  cancelBtn: {
    padding: "12px 22px",
    border: "1px solid var(--sales-portal-accent-tint)",
    borderRadius: "8px",
    backgroundColor: "var(--sales-portal-accent-lighter)",
    color: "var(--sales-portal-accent-dark)",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
  },
  centerCard: {
    backgroundColor: "white",
    borderRadius: "12px",
    padding: "48px",
    maxWidth: "500px",
    boxShadow: "0 4px 6px rgba(0, 0, 0, 0.07)",
    border: "1px solid #e5e7eb",
  },
  emptyStateIcon: {
    fontSize: "64px",
    marginBottom: "24px",
    display: "block",
  },
  emptyStateTitle: {
    fontSize: "28px",
    fontWeight: 600,
    color: "#1f2937",
    margin: "0 0 16px 0",
    fontFamily: "'Poppins', sans-serif",
  },
  emptyStateMessage: {
    fontSize: "16px",
    color: "#4b5563",
    margin: "0 0 8px 0",
    lineHeight: 1.6,
  },
  emptyStateSubtext: {
    fontSize: "14px",
    color: "#6b7280",
    margin: "0 0 32px 0",
    lineHeight: 1.6,
  },
  logoutForm: {
    display: "flex",
    gap: "8px",
  },
  logoutBtn: {
    flex: 1,
    padding: "12px 24px",
    backgroundColor: "#ef4444",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background-color 0.2s",
  },
};
