import type React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { Prisma } from "@prisma/client";
import prisma from "app/db.server";
import { getAdminForShop } from "app/shopify.server";
import {
  SalesPortalHeader,
  SalesPortalLayout,
  salesPortalButtonStyles,
} from "app/components/SalesPortalLayout";
import {
  buildClearSessionCookie,
  requireSalesSession,
} from "app/utils/sales-session.server";
import {
  getOrderAccessWhere,
  getOrderNumber,
  getAccessibleOrder,
  getSalesOrderAccessLevel,
  getShopifyOrderWhere,
  fetchShopifyOrderNames,
} from "app/services/sales-order-management.server";
import { restoreCredit } from "app/services/creditService";
import {
  assertNoShopifyUserErrors,
  shopifyOrderGraphql,
} from "app/services/shopify-order-creation.server";

const ORDER_STATUSES = [
  "draft",
  "payment_pending",
  "paid",
  "processing",
  "completed",
  "cancelled",
  "refunded",
];
const PAYMENT_STATUSES = ["pending", "partial", "paid", "failed", "expired"];

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const url = new URL(request.url);
  const search = (url.searchParams.get("search") || "").trim();
  const status = url.searchParams.get("status") || "";
  const paymentStatus = url.searchParams.get("paymentStatus") || "";
  const companyId = url.searchParams.get("company") || "";
  const customer = url.searchParams.get("customer") || "";
  const agentId = url.searchParams.get("agent") || "";
  const dateFrom = url.searchParams.get("dateFrom") || "";
  const dateTo = url.searchParams.get("dateTo") || "";
  const exportType = url.searchParams.get("export") || "";
  const createdOrder = url.searchParams.get("createdOrder") || "";
  const syncWarning = url.searchParams.get("syncWarning") === "1";
  const deletedOrder = url.searchParams.get("deletedOrder") || "";
  const accessLevel = getSalesOrderAccessLevel(user);
  const accessWhere = getOrderAccessWhere(user);
  const shopifyOrderWhere = getShopifyOrderWhere();

  const filters: Prisma.B2BOrderWhereInput[] = [];
  if (search) {
    filters.push({
      OR: [
        { orderNumber: { contains: search, mode: "insensitive" } },
        { shopifyOrderId: { contains: search, mode: "insensitive" } },
        { customerName: { contains: search, mode: "insensitive" } },
        { customerEmail: { contains: search, mode: "insensitive" } },
        { poNumber: { contains: search, mode: "insensitive" } },
        { company: { name: { contains: search, mode: "insensitive" } } },
      ],
    });
  }
  if (status) filters.push({ orderStatus: status });
  if (paymentStatus) filters.push({ paymentStatus });
  if (companyId && companyId !== "all") filters.push({ companyId });
  if (customer) filters.push({ customerEmail: customer });
  if (agentId && accessLevel !== "agent")
    filters.push({ createdByUserId: agentId });
  if (dateFrom || dateTo) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (dateFrom) createdAt.gte = new Date(`${dateFrom}T00:00:00.000`);
    if (dateTo) createdAt.lte = new Date(`${dateTo}T23:59:59.999`);
    filters.push({ createdAt });
  }

  const baseWhere: Prisma.B2BOrderWhereInput = {
    AND: [accessWhere, shopifyOrderWhere],
  };
  const where: Prisma.B2BOrderWhereInput = {
    AND: [baseWhere, ...filters],
  };

  const [orders, summaryRows, agents, quoteCount] = await Promise.all([
    prisma.b2BOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: exportType ? undefined : 250,
      include: {
        company: {
          select: {
            id: true,
            name: true,
            shop: { select: { shopDomain: true, accessToken: true } },
          },
        },
        createdByUser: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        items: { select: { quantity: true } },
      },
    }),
    prisma.b2BOrder.findMany({
      where: baseWhere,
      select: { orderStatus: true, paymentStatus: true, orderTotal: true },
    }),
    prisma.user.findMany({
      where: {
        role: "SALES_USER",
        salesCompanies: {
          some: {
            companyId: {
              in: user.salesCompanies.map((item) => item.companyId),
            },
          },
        },
      },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: { firstName: "asc" },
    }),
    prisma.quote.count({
      where: {
        companyId: { in: user.salesCompanies.map((item) => item.companyId) },
        ...(accessLevel === "agent" ? { salesAgentId: user.id } : {}),
      },
    }),
  ]);

  const orderNames = await fetchShopifyOrderNames(orders);

  if (exportType === "csv" || exportType === "excel") {
    const headings = [
      "Shopify Order Name",
      "Customer",
      "Email",
      "Company",
      "Sales Agent",
      "Items",
      "Quantity",
      "Order Total",
      "Payment Status",
      // "Order Status",
      "PO Number",
      "Created Date",
      "Last Updated",
    ];
    const separator = exportType === "excel" ? "\t" : ",";
    const rows = orders.map((order) => [
      orderNames.get(order.id) || getOrderNumber(order),
      order.customerName,
      order.customerEmail,
      order.company.name,
      [order.createdByUser.firstName, order.createdByUser.lastName]
        .filter(Boolean)
        .join(" ") || order.createdByUser.email,
      order.items.length,
      order.items.reduce((sum, item) => sum + item.quantity, 0),
      order.orderTotal.toString(),
      order.paymentStatus,
      // order.orderStatus,
      order.poNumber,
      order.createdAt.toISOString(),
      order.updatedAt.toISOString(),
    ]);
    const content = [headings, ...rows]
      .map((row) => row.map(csvCell).join(separator))
      .join("\n");
    return new Response(content, {
      headers: {
        "Content-Type":
          exportType === "excel"
            ? "application/vnd.ms-excel; charset=utf-8"
            : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="sales-orders.${exportType === "excel" ? "xls" : "csv"}"`,
      },
    });
  }

  const userCompanies = user.salesCompanies.map((item) => ({
    id: item.company.id,
    name: item.company.name,
  }));
  if (!userCompanies.length) return redirect("/sales/portal");

  const companies =
    userCompanies.length > 1
      ? [{ id: "all", name: "All companies" }, ...userCompanies]
      : userCompanies;

  const selectedCompanyId =
    companyId || (userCompanies.length > 1 ? "all" : userCompanies[0].id);

  const currentCompany =
    selectedCompanyId === "all"
      ? { id: "all", name: "All companies" }
      : userCompanies.find((item) => item.id === selectedCompanyId) ||
        userCompanies[0];

  const companyDetails = await prisma.companyAccount.findUnique({
    where: {
      id:
        currentCompany.id === "all"
          ? userCompanies[0].id
          : currentCompany.id,
    },
    select: { shop: { select: { themeColor: true } } },
  });
  const currentCompanyWithTheme = {
    ...currentCompany,
    themeColor: companyDetails?.shop.themeColor ?? null,
  };

  const customers = Array.from(
    new Map(
      orders
        .filter((order) => order.customerEmail)
        .map((order) => [
          order.customerEmail,
          { email: order.customerEmail, name: order.customerName },
        ]),
    ).values(),
  );
  const totalRevenue = summaryRows
    .filter((order) => order.paymentStatus === "paid")
    .reduce((sum, order) => sum + Number(order.orderTotal), 0);

  return Response.json({
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    accessLevel,
    currentCompany: currentCompanyWithTheme,
    companies,
    agents,
    customers,
    quoteCount,
    createdOrder,
    syncWarning,
    deletedOrder,
    selectedCompanyId,
    filters: {
      search,
      status,
      paymentStatus,
      companyId: selectedCompanyId === "all" ? "all" : selectedCompanyId,
      customer,
      agentId,
      dateFrom,
      dateTo,
    },
    summary: {
      total: summaryRows.length,
      draft: summaryRows.filter((order) => order.orderStatus === "draft")
        .length,
      pending: summaryRows.filter((order) => order.paymentStatus === "pending")
        .length,
      paid: summaryRows.filter((order) => order.paymentStatus === "paid")
        .length,
      cancelled: summaryRows.filter(
        (order) => order.orderStatus === "cancelled",
      ).length,
      revenue: totalRevenue,
    },
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: getOrderNumber(order),
      shopifyOrderName: orderNames.get(order.id) || null,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      company: { id: order.company.id, name: order.company.name },
      salesAgent: order.createdByUser,
      itemCount: order.items.length,
      quantity: order.items.reduce((sum, item) => sum + item.quantity, 0),
      orderTotal: order.orderTotal.toString(),
      currencyCode: order.currencyCode,
      paymentStatus: order.paymentStatus,
      // orderStatus: order.orderStatus,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      paymentLink: order.paymentLink,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  if (intent === "logout") {
    return redirect("/sales/login", {
      headers: { "Set-Cookie": buildClearSessionCookie() },
    });
  }

  if (intent === "delete_order") {
  
    const orderId = String(formData.get("orderId") || "");
    if (!orderId) {
      return Response.json({ error: "Order not found." }, { status: 404 });
    }

    const order = await getAccessibleOrder(user, orderId);
    if (!order) {
      return Response.json({ error: "Order not found." }, { status: 404 });
    }

    const deletedOrderNumber = getOrderNumber(order);

    try {
      const admin = order.company.shop.accessToken
        ? await getAdminForShop(order.company.shop.shopDomain)
        : undefined;

      if (
        order.orderStatus !== "cancelled" &&
        ["pending", "partial"].includes(order.paymentStatus) &&
        order.remainingBalance.greaterThan(0)
      ) {
        await restoreCredit(
          order.companyId,
          order.id,
          order.remainingBalance,
          user.id,
          "cancelled",
          admin as any,
        );
      }

      if (
        order.shopifyOrderId &&
        admin &&
        order.orderStatus === "draft" &&
        !order.shopifyOrderId.includes("/Order/")
      ) {
        const draftOrderId = order.shopifyOrderId.startsWith("gid://")
          ? order.shopifyOrderId
          : `gid://shopify/DraftOrder/${order.shopifyOrderId}`;
        const deleteData = await shopifyOrderGraphql<{
          draftOrderDelete: {
            deletedId: string | null;
            userErrors: Array<{ field?: string[] | null; message: string }>;
          };
        }>({
          admin,
          operation: "DeleteSalesPortalDraftOrder",
          query: `#graphql
            mutation DeleteSalesPortalDraftOrder($input: DraftOrderDeleteInput!) {
              draftOrderDelete(input: $input) {
                deletedId
                userErrors { field message }
              }
            }
          `,
          variables: { input: { id: draftOrderId } },
        });
        assertNoShopifyUserErrors(
          "DeleteSalesPortalDraftOrder",
          deleteData.draftOrderDelete.userErrors,
        );
      }

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

      await prisma.b2BOrder.delete({ where: { id: order.id } });
    } catch (error) {
      console.error("[sales-order] delete failed", {
        orderId: order.id,
        shopifyOrderId: order.shopifyOrderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Order delete failed.",
        },
        { status: 400 },
      );
    }

    const redirectUrl = new URL(request.url);
    redirectUrl.searchParams.delete("createdOrder");
    redirectUrl.searchParams.delete("syncWarning");
    redirectUrl.searchParams.set("deletedOrder", deletedOrderNumber);
    return redirect(`${redirectUrl.pathname}${redirectUrl.search}`);
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};

export default function CentralOrderListPage() {
  const data = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const params = new URLSearchParams();
  Object.entries(data.filters).forEach(([key, value]) => {
    if (value) params.set(key, String(value));
  });

  const money = (amount: string | number, currency = "USD") =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      Number(amount) || 0,
    );
  const date = (value: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(value));
  const createOrderCompanyId = data.currentCompany.id === "all"
    ? data.companies[0]?.id || ""
    : data.currentCompany.id || data.companies[0]?.id || "";

  return (
    <SalesPortalLayout
      company={data.currentCompany}
      user={data.user}
      activePage="orders"
      orderCount={data.summary.total}
      quoteCount={data.quoteCount}
      themeColor={data.currentCompany.themeColor}
    >
      <SalesPortalHeader
        title="Orders"
        subtitle="View, track, and manage orders across your assigned companies."
        companyId={data.currentCompany.id}
        companies={data.companies}
        companySwitchPath="/sales/portal/orders?company="
        actions={
          <Link
            to={createOrderCompanyId ? `/sales/portal/company/${createOrderCompanyId}/create-order` : "/sales/portal"}
            style={salesPortalButtonStyles.primary}
          >
            + Create Order
          </Link>
        }
      />
      {data.createdOrder && (
        <div style={data.syncWarning ? styles.warningBanner : styles.successBanner}>
          {data.syncWarning
            ? `${data.createdOrder} is verified in Shopify Orders. Its Sales Portal record is still synchronizing.`
            : `${data.createdOrder} was created and verified in Shopify Orders.`}
        </div>
      )}
      {data.deletedOrder && (
        <div style={styles.successBanner}>
          {data.deletedOrder} was deleted from the Sales Portal order list.
        </div>
      )}
      {actionData?.error && (
        <div style={styles.errorBanner}>{actionData.error}</div>
      )}

      <section
        className="order-summary-grid"
        style={styles.summaryGrid}
        aria-label="Order summary"
      >
        <Summary label="Total Orders" value={data.summary.total} />
        {/* <Summary label="Draft Orders" value={data.summary.draft} /> */}
        <Summary label="Payment Pending" value={data.summary.pending} />
        <Summary label="Paid Orders" value={data.summary.paid} />
        <Summary label="Cancelled" value={data.summary.cancelled} />
        <Summary label="Total Revenue" value={money(data.summary.revenue)} />
      </section>

      <Form method="get" className="order-filter-grid" style={styles.filters}>
        <input
          name="search"
          defaultValue={data.filters.search}
          placeholder="Search order, customer, company, email or PO"
          style={styles.input}
        />
        <select
          name="status"
          defaultValue={data.filters.status}
          style={styles.input}
        >
          <option value="">All order statuses</option>
          {ORDER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {label(status)}
            </option>
          ))}
        </select>
        <select
          name="paymentStatus"
          defaultValue={data.filters.paymentStatus}
          style={styles.input}
        >
          <option value="">All payment statuses</option>
          {PAYMENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {paymentLabel(status)}
            </option>
          ))}
        </select>
        <select
          name="company"
          defaultValue={data.filters.companyId}
          style={styles.input}
        >
          {data.companies.map((company: any) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
        <select
          name="customer"
          defaultValue={data.filters.customer}
          style={styles.input}
        >
          <option value="">All customers</option>
          {data.customers.map((customer: any) => (
            <option key={customer.email} value={customer.email}>
              {customer.name || customer.email}
            </option>
          ))}
        </select>
        {data.accessLevel !== "agent" && (
          <select
            name="agent"
            defaultValue={data.filters.agentId}
            style={styles.input}
          >
            <option value="">All sales agents</option>
            {data.agents.map((agent: any) => (
              <option key={agent.id} value={agent.id}>
                {agent.firstName || agent.email} {agent.lastName || ""}
              </option>
            ))}
          </select>
        )}
        <input
          type="date"
          name="dateFrom"
          defaultValue={data.filters.dateFrom}
          aria-label="Created from"
          style={styles.input}
        />
        <input
          type="date"
          name="dateTo"
          defaultValue={data.filters.dateTo}
          aria-label="Created to"
          style={styles.input}
        />
        <button style={styles.filterButton}>Apply Filters</button>
        <Link to="/sales/portal/orders" style={styles.clearButton}>
          Clear
        </Link>
      </Form>

      <div style={styles.toolbar}>
        <strong>{data.orders.length} orders</strong>
        <div style={styles.exportActions}>
          <a
            href={`/sales/portal/orders?${params}&export=csv`}
            style={styles.exportButton}
            download="sales-orders.csv"
          >
            Export CSV
          </a>
          <a
            href={`/sales/portal/orders?${params}&export=excel`}
            style={styles.exportButton}
            download="sales-orders.xls"
          >
            Export Excel
          </a>
        </div>
      </div>

      <div className="sales-order-table-wrap" style={styles.tableCard}>
        <table style={styles.table}>
          <thead>
            <tr>
              {[
                "Order Name",
                "Customer",
                "Company",
                "Sales Agent",
                "Items",
                "Quantity",
                "Order Total",
                "Payment Status",
                // "Order Status",
                "Created Date",
                "Last Updated",
                "Actions",
              ].map((heading) => (
                <th key={heading} style={styles.th}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.orders.map((order: any) => (
              <tr key={order.id} style={styles.tr}>
                <td style={styles.td}>
                  <Link
                    to={`/sales/portal/orders/${order.id}`}
                    style={styles.orderLink}
                  >
                    {order.shopifyOrderName || order.orderNumber}
                  </Link>
                </td>
                <td style={styles.td}>
                  <strong>{order.customerName || "Not captured"}</strong>
                  <small style={styles.secondaryText}>
                    {order.customerEmail || "No email"}
                  </small>
                </td>
                <td style={styles.td}>{order.company.name}</td>
                <td style={styles.td}>
                  {[order.salesAgent.firstName, order.salesAgent.lastName]
                    .filter(Boolean)
                    .join(" ") || order.salesAgent.email}
                </td>
                <td style={styles.td}>{order.itemCount}</td>
                <td style={styles.td}>{order.quantity}</td>
                <td style={styles.td}>
                  <strong>{money(order.orderTotal, order.currencyCode)}</strong>
                </td>
                <td style={styles.td}>
                  <Status value={order.paymentStatus} kind="payment" />
                </td>
                {/* <td style={styles.td}>
                  <Status value={order.orderStatus} />
                </td> */}
                <td style={styles.td}>{date(order.createdAt)}</td>
                <td style={styles.td}>{date(order.updatedAt)}</td>
                <td style={styles.td}>
                  <div style={styles.rowActions}>
                    <Link
                      to={`/sales/portal/orders/${order.id}`}
                      style={styles.actionLink}
                    >
                      View Details
                    </Link>
                  
                      <Form
                        method="post"
                        style={styles.inlineForm}
                        onSubmit={(event) => {
                          if (
                            !confirm(
                              `Delete ${order.orderNumber} from the Sales Portal order list?`,
                            )
                          ) {
                            event.preventDefault();
                          }
                        }}
                      >
                        <input type="hidden" name="intent" value="delete_order" />
                        <input type="hidden" name="orderId" value={order.id} />
                        <button
                          type="submit"
                          disabled={busy}
                          style={styles.deleteButton}
                        >
                          Delete
                        </button>
                      </Form>
                
                  </div>
                </td>
              </tr>
            ))}
            {!data.orders.length && (
              <tr>
                <td colSpan={12} style={styles.empty}>
                  No orders match the selected filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <style>{responsiveCss}</style>
    </SalesPortalLayout>
  );
}

function label(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
function paymentLabel(value: string) {
  return value === "partial" ? "Partially Paid" : label(value);
}
function Summary({
  label: title,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div style={styles.summaryCard}>
      <span style={styles.summaryLabel}>{title}</span>
      <strong style={styles.summaryValue}>{value}</strong>
    </div>
  );
}
function Status({
  value,
  kind = "order",
}: {
  value: string;
  kind?: "order" | "payment";
}) {
  const good = ["paid", "completed"].includes(value);
  const bad = ["cancelled", "refunded", "failed", "expired"].includes(value);
  return (
    <span
      style={{
        ...styles.badge,
        background: good ? "#dcfce7" : bad ? "#fee2e2" : "#fef3c7",
        color: good ? "#166534" : bad ? "#991b1b" : "#854d0e",
      }}
    >
      {kind === "payment" ? paymentLabel(value) : label(value)}
    </span>
  );
}

const responsiveCss = `
  .sales-order-table-wrap { overflow-x: auto; }
  @media (max-width: 1180px) { .order-summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; } .order-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } }
  @media (max-width: 620px) { .order-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } .order-filter-grid { grid-template-columns: minmax(0, 1fr) !important; } }
`;
const styles: Record<string, React.CSSProperties> = {
  successBanner: { marginBottom: 16, padding: 12, border: "1px solid #a7f3d0", borderRadius: 8, background: "#ecfdf5", color: "#065f46", fontSize: 13 },
  warningBanner: { marginBottom: 16, padding: 12, border: "1px solid #fde68a", borderRadius: 8, background: "#fffbeb", color: "#92400e", fontSize: 13 },
  errorBanner: { marginBottom: 16, padding: 12, border: "1px solid #fecaca", borderRadius: 8, background: "#fef2f2", color: "#991b1b", fontSize: 13 },
  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
    gap: 12,
    marginBottom: 20,
  },
  summaryCard: {
    background: "#fff",
    border: "1px solid #e1e3e5",
    borderRadius: 8,
    padding: 16,
    minWidth: 0,
  },
  summaryLabel: {
    display: "block",
    color: "#6d7175",
    fontSize: 12,
    marginBottom: 8,
  },
  summaryValue: {
    display: "block",
    color: "#202223",
    fontSize: 22,
    fontFamily: "'Poppins', sans-serif",
  },
  filters: {
    display: "grid",
    gridTemplateColumns: "minmax(240px, 2fr) repeat(5, minmax(140px, 1fr))",
    gap: 10,
    padding: 16,
    marginBottom: 18,
    background: "#fff",
    border: "1px solid #e1e3e5",
    borderRadius: 8,
  },
  input: {
    width: "100%",
    height: 40,
    padding: "0 11px",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    background: "#fff",
    color: "#202223",
    font: "inherit",
    fontSize: 13,
  },
  filterButton: {
    height: 40,
    border: "1px solid var(--sales-portal-accent)",
    borderRadius: 8,
    background: "var(--sales-portal-accent)",
    color: "var(--sales-portal-accent-contrast)",
    fontWeight: 600,
    cursor: "pointer",
  },
  clearButton: {
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--sales-portal-accent)",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 600,
    border: "1px solid var(--sales-portal-accent-tint)",
    borderRadius: 8,
    background: "var(--sales-portal-accent-lighter)",
    padding: "0 12px",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
  },
  exportActions: { display: "flex", gap: 8 },
  exportButton: {
    padding: "8px 11px",
    border: "1px solid var(--sales-portal-accent-tint)",
    borderRadius: 8,
    background: "var(--sales-portal-accent-lighter)",
    color: "var(--sales-portal-accent-dark)",
    textDecoration: "none",
    fontSize: 12,
    fontWeight: 600,
  },
  tableCard: {
    background: "#fff",
    border: "1px solid #e1e3e5",
    borderRadius: 8,
  },
  table: { width: "100%", minWidth: 1500, borderCollapse: "collapse" },
  th: {
    padding: "12px 14px",
    borderBottom: "1px solid #e1e3e5",
    color: "#6d7175",
    textAlign: "left",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid #f1f2f3" },
  td: {
    padding: "13px 14px",
    color: "#202223",
    fontSize: 13,
    verticalAlign: "middle",
  },
  secondaryText: { display: "block", color: "#8c9196", marginTop: 3 },
  orderLink: {
    color: "var(--sales-portal-accent)",
    fontWeight: 700,
    textDecoration: "none",
    whiteSpace: "nowrap",
  },
  actionLink: {
    color: "var(--sales-portal-accent)",
    fontWeight: 600,
    textDecoration: "none",
    whiteSpace: "nowrap",
  },
  rowActions: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    whiteSpace: "nowrap",
  },
  inlineForm: { display: "inline-flex", margin: 0 },
  deleteButton: {
    border: 0,
    padding: 0,
    background: "transparent",
    color: "#b42318",
    font: "inherit",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  badge: {
    display: "inline-flex",
    padding: "4px 9px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  empty: { padding: 40, color: "#6d7175", textAlign: "center" },
};
