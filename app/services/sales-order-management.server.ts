import type { Prisma } from "@prisma/client";
import prisma from "app/db.server";
import { getAdminForShop } from "app/shopify.server";
import type { SalesSessionUser } from "app/utils/sales-session.server";
import { sendOrderPaymentLinkEmail } from "app/utils/email";

export type SalesOrderAccessLevel = "agent" | "manager" | "admin";

export function getSalesOrderAccessLevel(
  user: SalesSessionUser,
): SalesOrderAccessLevel {
  const role = (user.companyRole || "").toLowerCase().replace(/[\s_-]/g, "");
  if (role.includes("admin")) return "admin";
  if (role.includes("manager") || role.includes("lead")) return "manager";
  return "agent";
}

export function getAccessibleCompanyIds(user: SalesSessionUser) {
  return user.salesCompanies.map((assignment) => assignment.companyId);
}

export function getOrderAccessWhere(
  user: SalesSessionUser,
): Prisma.B2BOrderWhereInput {
  const companyIds = getAccessibleCompanyIds(user);
  const accessLevel = getSalesOrderAccessLevel(user);

  // Sales users should see all orders for companies assigned to them,
  // even if they did not create the order themselves.
  if (user.role === "SALES_USER") {
    return {
      companyId: { in: companyIds },
      orderStatus: { notIn: ["converted", "archived"] },
    };
  }

  return {
    companyId: { in: companyIds },
    orderStatus: { notIn: ["converted", "archived"] },
    ...(accessLevel === "agent" ? { createdByUserId: user.id } : {}),
  };
}

export function getShopifyOrderWhere(): Prisma.B2BOrderWhereInput {
  return {
    shopifyOrderId: { startsWith: "gid://shopify/Order/" },
  };
}

export async function getAccessibleOrder(
  user: SalesSessionUser,
  orderId: string,
) {
  return prisma.b2BOrder.findFirst({
    where: { id: orderId, ...getOrderAccessWhere(user) },
    include: {
      company: { include: { shop: true } },
      createdByUser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      items: { orderBy: { createdAt: "asc" } },
      payments: { orderBy: { createdAt: "desc" } },
      activities: {
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
        },
      },
    },
  });
}

export async function logOrderActivity(input: {
  orderId: string;
  userId?: string | null;
  action: string;
  message?: string | null;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.orderActivity.create({
    data: {
      orderId: input.orderId,
      userId: input.userId,
      action: input.action,
      message: input.message,
      metadata: input.metadata,
    },
  });
}

export function getOrderNumber(order: {
  orderNumber: string | null;
  shopifyOrderId: string | null;
  id: string;
}) {
  return (
    order.orderNumber ||
    (order.shopifyOrderId
      ? `#${order.shopifyOrderId.split("/").pop()}`
      : null) ||
    `ORD-${order.id.slice(-8).toUpperCase()}`
  );
}

type ShopifyNameLookupOrder = {
  id: string;
  shopifyOrderId: string | null;
  company: {
    shop: { shopDomain: string; accessToken: string | null } | null;
  };
};

/**
 * Batch-fetches the Shopify order name (e.g. "#1008") for B2B orders using a
 * single `nodes` query per shop. Falls back to an empty map if anything fails.
 */
export async function fetchShopifyOrderNames(
  orders: ShopifyNameLookupOrder[],
): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  const byShop = new Map<
    string,
    { accessToken: string; entries: Array<{ gid: string; orderId: string }> }
  >();

  for (const order of orders) {
    const rawId = order.shopifyOrderId;
    if (!rawId?.startsWith("gid://shopify/Order/")) continue;
    const shop = order.company?.shop;
    if (!shop?.shopDomain || !shop.accessToken) continue;
    const entry = { gid: rawId, orderId: order.id };
    const existing = byShop.get(shop.shopDomain);
    if (existing) {
      existing.entries.push(entry);
    } else {
      byShop.set(shop.shopDomain, {
        accessToken: shop.accessToken,
        entries: [entry],
      });
    }
  }

  const query = `
    query GetShopifyOrderNames($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          name
        }
      }
    }
  `;

  for (const [shopDomain, { accessToken, entries }] of byShop) {
    for (let i = 0; i < entries.length; i += 250) {
      const chunk = entries.slice(i, i + 250);
      try {
        const response = await fetch(
          `https://${shopDomain}/admin/api/2025-01/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,
            },
            body: JSON.stringify({
              query,
              variables: { ids: chunk.map((entry) => entry.gid) },
            }),
          },
        );
        const payload = (await response.json()) as {
          data?: { nodes?: Array<{ id: string; name: string } | null> };
          errors?: Array<{ message: string }>;
        };
        if (payload.errors?.length) {
          console.warn("[sales-orders] Shopify order name lookup failed", {
            shopDomain,
            errors: payload.errors,
          });
          continue;
        }
        const nodes = payload.data?.nodes || [];
        nodes.forEach((node) => {
          if (!node?.id) return;
          const entry = chunk.find((item) => item.gid === node.id);
          if (entry) names.set(entry.orderId, node.name || null);
        });
      } catch (error) {
        console.error("[sales-orders] Shopify order name lookup unavailable", {
          shopDomain,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return names;
}

export function isSalesPortalPaymentLinkEligible(order: {
  source: string | null;
  paymentStatus: string;
  orderStatus: string;
}) {
  const source = (order.source || "").toLowerCase();
  return (
    (source === "sales portal" || source === "sales portal quote") &&
    order.paymentStatus.toLowerCase() === "pending" &&
    order.orderStatus.toLowerCase() !== "cancelled"
  );
}

const SALES_PORTAL_PAYMENT_LINK_SOURCES = [
  "Sales Portal",
  "Sales Portal Quote",
];

type PaymentLinkOrder = {
  id: string;
  source: string | null;
  shopifyOrderId: string | null;
  paymentStatus: string;
  orderStatus: string;
  remainingBalance: { toString(): string };
  currencyCode: string;
  customerEmail: string | null;
  paymentLink: string | null;
  paymentLinkToken: string | null;
  company: {
    shop: {
      shopDomain: string;
    };
  };
};

export async function getOrCreateSalesOrderPaymentLink(
  order: PaymentLinkOrder,
) {
  if (!isSalesPortalPaymentLinkEligible(order)) {
    throw new Error(
      "Payment links are available only for pending Sales Portal orders.",
    );
  }
  if (!order.shopifyOrderId?.startsWith("gid://shopify/Order/")) {
    throw new Error(
      "This Sales Portal order is not connected to a Shopify order.",
    );
  }

  const admin = await getAdminForShop(order.company.shop.shopDomain);
  const response = await admin.graphql(
    `#graphql
      query SalesPortalPaymentLink($id: ID!) {
        order(id: $id) {
          id
          cancelledAt
          displayFinancialStatus
          statusPageUrl
          paymentCollectionDetails {
            additionalPaymentCollectionUrl
          }
          email
          customer {
            email
          }
          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
    `,
    { variables: { id: order.shopifyOrderId } },
  );
  const payload = (await response.json()) as {
    data?: {
      order?: {
        id: string;
        cancelledAt: string | null;
        displayFinancialStatus: string | null;
        statusPageUrl: string;
        paymentCollectionDetails: {
          additionalPaymentCollectionUrl: string | null;
        };
        email: string | null;
        customer: { email: string | null } | null;
        totalOutstandingSet: {
          shopMoney: { amount: string; currencyCode: string };
        };
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  const shopifyOrder = payload.data?.order;
  if (!shopifyOrder || shopifyOrder.id !== order.shopifyOrderId) {
    throw new Error("The connected Shopify order could not be verified.");
  }
  if (shopifyOrder.cancelledAt) {
    throw new Error("Cancelled orders cannot receive a payment link.");
  }
  if (shopifyOrder.displayFinancialStatus?.toLowerCase() !== "pending") {
    throw new Error("Shopify no longer reports this order as pending payment.");
  }

  const outstanding = shopifyOrder.totalOutstandingSet.shopMoney;
  const expectedAmount = Number(order.remainingBalance.toString());
  const providerAmount = Number(outstanding.amount);
  if (
    outstanding.currencyCode !== order.currencyCode ||
    !Number.isFinite(providerAmount) ||
    Math.abs(providerAmount - expectedAmount) > 0.009
  ) {
    throw new Error(
      "The Shopify payment amount or currency does not match the Sales Portal order.",
    );
  }

  const providerEmail = shopifyOrder.email || shopifyOrder.customer?.email;
  if (
    order.customerEmail &&
    providerEmail &&
    order.customerEmail.toLowerCase() !== providerEmail.toLowerCase()
  ) {
    throw new Error(
      "The Shopify customer does not match the Sales Portal order.",
    );
  }

  const paymentLink =
    shopifyOrder.paymentCollectionDetails.additionalPaymentCollectionUrl;
  if (!paymentLink) {
    console.error("[sales-payment-link] Shopify has no collection URL", {
      orderId: order.id,
      shopifyOrderId: order.shopifyOrderId,
      financialStatus: shopifyOrder.displayFinancialStatus,
      hasStatusPageUrl: Boolean(shopifyOrder.statusPageUrl),
    });
    throw new Error(
      "Shopify has not enabled online payment collection for this order. Check the store payment gateway and B2B payment settings.",
    );
  }
  const parsedPaymentLink = new URL(paymentLink);
  if (parsedPaymentLink.protocol !== "https:") {
    console.error(
      "[sales-payment-link] Shopify returned an unsafe collection URL",
      {
        orderId: order.id,
        shopifyOrderId: order.shopifyOrderId,
      },
    );
    throw new Error("Shopify returned an invalid payment collection URL.");
  }

  const reused = order.paymentLink === paymentLink && !order.paymentLinkToken;
  const saved = await prisma.b2BOrder.updateMany({
    where: {
      id: order.id,
      source: { in: SALES_PORTAL_PAYMENT_LINK_SOURCES },
      paymentStatus: "pending",
      orderStatus: { not: "cancelled" },
    },
    data: reused
      ? { paymentLink }
      : {
          paymentLink,
          paymentLinkToken: null,
          paymentLinkAt: new Date(),
        },
  });
  if (saved.count === 0) {
    throw new Error("This order is no longer eligible for a payment link.");
  }

  return { link: paymentLink, reused };
}

type PendingOrderPaymentEmailOrder = PaymentLinkOrder & {
  shopId: string;
  orderNumber: string | null;
  customerName: string | null;
  company: {
    name: string;
    shop: {
      shopDomain: string;
    };
  };
};

export async function sendPendingOrderPaymentRequestEmail(
  order: PendingOrderPaymentEmailOrder,
  userId?: string | null,
) {
  if (!order.customerEmail) {
    return { success: false, skipped: true, error: "Missing customer email" };
  }

  let generated: Awaited<
    ReturnType<typeof getOrCreateSalesOrderPaymentLink>
  > | null = null;
  let lastLinkError: unknown;
  for (const delay of [0, 1000, 2500]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      generated = await getOrCreateSalesOrderPaymentLink(order);
      lastLinkError = null;
      break;
    } catch (error) {
      lastLinkError = error;
    }
  }
  if (lastLinkError) {
    throw lastLinkError;
  }
  if (!generated) {
    throw new Error("Payment link generation failed.");
  }

  const emailResult = await sendOrderPaymentLinkEmail({
    storeId: order.shopId,
    to: order.customerEmail,
    customerName: order.customerName,
    orderNumber: getOrderNumber(order),
    companyName: order.company.name,
    totalAmount: order.remainingBalance.toString(),
    currencyCode: order.currencyCode,
    paymentUrl: generated.link,
  });

  if (emailResult.success) {
    await prisma.b2BOrder.update({
      where: { id: order.id },
      data: { paymentLinkSentAt: new Date() },
    });
  }

  await logOrderActivity({
    orderId: order.id,
    userId,
    action: emailResult.success
      ? "Payment Link Sent"
      : "Payment Link Email Failed",
    message: emailResult.success
      ? `Sent to ${order.customerEmail}.`
      : emailResult.error,
    metadata: {
      generatedLink: generated.link,
      emailResult,
    } as Prisma.InputJsonValue,
  });

  return { ...emailResult, paymentLink: generated.link };
}

export async function notifyOrderCreator(input: {
  orderId: string;
  receiverId: string;
  shopId: string;
  shopifyOrderId?: string | null;
  title: string;
  message: string;
  activityType: string;
}) {
  return prisma.notification.create({
    data: {
      receiverId: input.receiverId,
      shopId: input.shopId,
      shopifyOrderId: input.shopifyOrderId,
      title: input.title,
      message: input.message,
      activityType: input.activityType,
      activeAction: input.activityType,
    },
  });
}
