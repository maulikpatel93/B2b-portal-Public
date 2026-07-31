import prisma from "../db.server";
import { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  parseCredit,
  syncShopifyUsers,
  syncShopifyCompanies,
  syncShopifyOrders,
} from "app/utils/company.server";
import {
  getCompanyCustomers,
  getCompanyLocations,
} from "app/utils/b2b-customer.server";
import { syncCompanyCreditMetafields } from "./metafieldSync.server";

export interface CreateCompanyInput {
  shopId: string;
  shopifyCompanyId?: string | null;
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  creditLimit?: number | Prisma.Decimal;
}

export interface UpdateCompanyInput {
  shopifyCompanyId?: string | null;
  name?: string;
  contactName?: string | null;
  contactEmail?: string | null;
  creditLimit?: number | Prisma.Decimal;
}

export interface ShopifyCustomer {
  id: string;
  customerId: string;
  customer?: {
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  roles?: string[];
  locationNames?: string[];
}

export interface CreateCreditTransactionInput {
  companyId: string;
  orderId?: string | null;
  transactionType: string;
  creditAmount: number | Prisma.Decimal;
  previousBalance: number | Prisma.Decimal;
  newBalance: number | Prisma.Decimal;
  notes?: string | null;
  createdBy: string;
}
export interface ShopifyOrder {
  id: string;
  shopifyOrderId: string;
  customer?: {
    email?: string;
  };
  remainingBalance: Prisma.Decimal;
}

async function getStoreDefaultCompanyCreditLimit(shopId: string) {
  const store = await prisma.store.findUnique({
    where: { id: shopId },
    select: { defaultCompanyCreditLimit: true },
  });

  return store?.defaultCompanyCreditLimit ?? new Prisma.Decimal(0);
}

/**
 * Create a new company account
 */
export async function createCompany(data: CreateCompanyInput) {
  const creditLimit =
    data.creditLimit !== undefined
      ? new Prisma.Decimal(data.creditLimit.toString())
      : await getStoreDefaultCompanyCreditLimit(data.shopId);

  return await prisma.companyAccount.create({
    data: {
      shopId: data.shopId,
      shopifyCompanyId: data.shopifyCompanyId,
      name: data.name,
      contactName: data.contactName,
      contactEmail: data.contactEmail,
      creditLimit,
    },
    include: {
      users: true,
      orders: true,
      creditTransactions: true,
    },
  });
}

/**
 * Get company by ID
 */
export async function getCompanyById(id: string) {
  return await prisma.companyAccount.findUnique({
    where: { id },
    include: {
      shop: true,
      users: true,
      orders: true,
      creditTransactions: true,
    },
  });
}

/**
 * Get company by Shopify company ID
 */
export async function getCompanyByShopifyId(
  shopId: string,
  shopifyCompanyId: string,
) {
  return await prisma.companyAccount.findUnique({
    where: {
      shopId_shopifyCompanyId: {
        shopId,
        shopifyCompanyId,
      },
    },
    include: {
      users: true,
      orders: true,
    },
  });
}

/**
 * Get all companies for a shop
 */
export async function getCompaniesByShop(
  shopId: string,
  options?: {
    orderBy?: Prisma.CompanyAccountOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  return await prisma.companyAccount.findMany({
    where: { shopId },
    orderBy: options?.orderBy || { updatedAt: "desc" },
    take: options?.take,
    skip: options?.skip,
    include: {
      _count: {
        select: {
          users: true,
          orders: true,
        },
      },
    },
  });
}

/**
 * Update a company
 */
export async function updateCompany(id: string, data: UpdateCompanyInput) {
  const updateData: Prisma.CompanyAccountUpdateInput = {
    ...data,
    updatedAt: new Date(),
  };

  if (data.creditLimit !== undefined) {
    updateData.creditLimit = new Prisma.Decimal(data.creditLimit.toString());
  }

  return await prisma.companyAccount.update({
    where: { id },
    data: updateData,
    include: {
      users: true,
      orders: true,
    },
  });
}

/**
 * Upsert a company (create or update)
 */
export async function upsertCompany(
  shopId: string,
  shopifyCompanyId: string,
  data: Omit<CreateCompanyInput, "shopId" | "shopifyCompanyId">,
) {
  const createCreditLimit =
    data.creditLimit !== undefined
      ? new Prisma.Decimal(data.creditLimit.toString())
      : await getStoreDefaultCompanyCreditLimit(shopId);

  return await prisma.companyAccount.upsert({
    where: {
      shopId_shopifyCompanyId: {
        shopId,
        shopifyCompanyId,
      },
    },
    update: {
      name: data.name,
      contactName: data.contactName,
      contactEmail: data.contactEmail,
      creditLimit: data.creditLimit
        ? new Prisma.Decimal(data.creditLimit.toString())
        : undefined,
      updatedAt: new Date(),
    },
    create: {
      shopId,
      shopifyCompanyId,
      name: data.name,
      contactName: data.contactName,
      contactEmail: data.contactEmail,
      creditLimit: createCreditLimit,
    },
    include: {
      users: true,
    },
  });
}

/**
 * Delete a company
 */
export async function deleteCompany(id: string) {
  return await prisma.companyAccount.delete({
    where: { id },
  });
}

/**
 * Count companies for a shop
 */
export async function countCompanies(shopId: string) {
  return await prisma.companyAccount.count({
    where: { shopId },
  });
}

/**
 * Create a credit transaction
 */
export async function createCreditTransaction(
  data: CreateCreditTransactionInput,
) {
  return await prisma.creditTransaction.create({
    data: {
      companyId: data.companyId,
      orderId: data.orderId,
      transactionType: data.transactionType,
      creditAmount: new Prisma.Decimal(data.creditAmount.toString()),
      previousBalance: new Prisma.Decimal(data.previousBalance.toString()),
      newBalance: new Prisma.Decimal(data.newBalance.toString()),
      notes: data.notes,
      createdBy: data.createdBy,
      createdAt: new Date(),
    },
  });
}

/**
 * Get credit transactions for a company
 */
export async function getCreditTransactionsByCompany(
  companyId: string,
  options?: {
    transactionType?: string | string[];
    orderBy?: Prisma.CreditTransactionOrderByWithRelationInput;
    take?: number;
    skip?: number;
    shop?: string;
    accessToken?: string;
  },
) {
  const where: Prisma.CreditTransactionWhereInput = { companyId };

  if (options?.transactionType) {
    where.transactionType = Array.isArray(options.transactionType)
      ? { in: options.transactionType }
      : options.transactionType;
  }

  const creditTransactions = await prisma.creditTransaction.findMany({
    where,
    orderBy: options?.orderBy || { createdAt: "desc" },
    take: options?.take,
    skip: options?.skip,
  });

  // ── Batch fetch users & orders ─────────────────────────────
  const createdByIds = [
    ...new Set(creditTransactions.map((tx) => tx.createdBy).filter(Boolean)),
  ];
  const orderIds = [
    ...new Set(creditTransactions.map((tx) => tx.orderId).filter(Boolean)),
  ] as string[];

  const [users, orders] = await Promise.all([
    createdByIds.length
      ? prisma.user.findMany({
          where: { id: { in: createdByIds as string[] } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : Promise.resolve([]),
    orderIds.length
      ? prisma.b2BOrder.findMany({
          where: {
            OR: [
              { id: { in: orderIds } },
              { shopifyOrderId: { in: orderIds } },
            ],
          },
          select: { id: true, shopifyOrderId: true, orderNumber: true },
        })
      : Promise.resolve([]),
  ]);

  // ── Map userId → display name ────────────────────────────────
  const userMap = new Map(
    users.map((u) => [
      u.id,
      u.firstName || u.lastName
        ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()
        : u.email,
    ]),
  );

  // ── Map orderId/shopifyOrderId → shopifyOrderId ──────────────
  const orderMap = new Map();
  const orderNameMap = new Map<string, string | null>();

  // Start with local orderNumber as fallback
  orders.forEach((o) => {
    if (o.id) orderNameMap.set(o.id, o.orderNumber);
    if (o.shopifyOrderId) {
      orderNameMap.set(o.shopifyOrderId, o.orderNumber);
      orderMap.set(o.id, o.shopifyOrderId);
      orderMap.set(o.shopifyOrderId, o.shopifyOrderId);
    }
  });

  // ── Fetch Shopify order names via GraphQL ────────────────────
  if (options?.shop && options?.accessToken) {
    const shopifyOrderGids = [
      ...new Set(
        orders
          .map((o) => o.shopifyOrderId)
          .filter(
            (id): id is string => !!id && id.startsWith("gid://shopify/Order/"),
          ),
      ),
    ];

    if (shopifyOrderGids.length > 0) {
      try {
        const nodesQuery = `
          query GetOrderNames($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Order {
                id
                name
              }
            }
          }
        `;

        const response = await fetch(
          `https://${options.shop}/admin/api/2025-01/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": options.accessToken,
            },
            body: JSON.stringify({
              query: nodesQuery,
              variables: { ids: shopifyOrderGids },
            }),
          },
        );

        const data = await response.json();

        if (!data.errors && data.data?.nodes) {
          for (const node of data.data.nodes) {
            if (node?.id && node?.name) {
              // Override the local orderNumber with the Shopify name (e.g. "#1000")
              orderNameMap.set(node.id, node.name);
            }
          }
        }
      } catch (err) {
        console.error("Failed to fetch order names from Shopify:", err);
      }
    }
  }

  // ── Attach metadata to each transaction ─────────────────────
  return creditTransactions.map((tx) => {
    const shopifyOrderId = tx.orderId ? orderMap.get(tx.orderId) : null;
    const finalOrderId = shopifyOrderId || tx.orderId;
    return {
      ...tx,
      orderId: finalOrderId,
      orderName: tx.orderId
        ? (orderNameMap.get(tx.orderId) ?? finalOrderId)
        : null,
      createdByName: tx.createdBy ? (userMap.get(tx.createdBy) ?? null) : null,
      shopifyOrderId: finalOrderId,
    };
  });
}

/**
 * Count credit transactions
 */
export async function countCreditTransactions(
  where: Prisma.CreditTransactionWhereInput,
) {
  return await prisma.creditTransaction.count({ where });
}

/**
 * Get company with credit summary
 */
export async function getCompanyWithCreditSummary(companyId: string) {
  const company = await getCompanyById(companyId);

  if (!company) {
    return null;
  }

  // Get pending orders total
  const pendingOrders = await prisma.b2BOrder.aggregate({
    where: {
      companyId,
      orderStatus: { in: ["draft", "submitted", "processing"] },
    },
    _sum: {
      remainingBalance: true,
    },
    _count: true,
  });

  const pendingCredit = pendingOrders._sum.remainingBalance
    ? new Prisma.Decimal(pendingOrders._sum.remainingBalance)
    : new Prisma.Decimal(0);
  const usedCredit = company.creditLimit.minus(pendingCredit);
  const availableCredit = company.creditLimit.minus(pendingCredit);

  return {
    company,
    creditLimit: company.creditLimit,
    usedCredit,
    pendingCredit,
    availableCredit,
    pendingOrderCount: pendingOrders._count,
  };
}

/**
 * Get company dashboard data
 */
export async function getCompanyDashboardData(
  companyId: string,
  shopId: string,
  shop: string,
  accessToken: string,
) {
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      shopId: true,
      shopifyCompanyId: true,
      paymentTerm: true,
      isDisable: true,
    },
  });

  if (!company || company.shopId !== shopId) {
    return null;
  }

  const recentOrders = await prisma.b2BOrder.findMany({
    where: {
      companyId,
      orderStatus: { notIn: ["cancelled", "converted", "archived"] },
      shopifyOrderId: { startsWith: "gid://shopify/Order/" },
    },
    distinct: ["shopifyOrderId"],
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      createdByUser: {
        select: {
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  // Fetch order names from Shopify GraphQL
  const orderGids = recentOrders
    .map((o) => o.shopifyOrderId)
    .filter(Boolean) as string[];

  // Build a map of GID -> order name from Shopify
  const orderNameMap = new Map<string, string>();

  if (orderGids.length > 0) {
    try {
      // Shopify nodes query to fetch multiple orders by GID at once
      const nodesQuery = `
        query GetOrderNames($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Order {
              id
              name
            }
          }
        }
      `;

      const response = await fetch(
        `https://${shop}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query: nodesQuery,
            variables: { ids: orderGids },
          }),
        },
      );

      const data = await response.json();

      if (!data.errors && data.data?.nodes) {
        for (const node of data.data.nodes) {
          if (node?.id && node?.name) {
            orderNameMap.set(node.id, node.name); // e.g. "gid://shopify/Order/123" -> "#1008"
          }
        }
      }
    } catch (err) {
      console.error("Failed to fetch order names from Shopify:", err);
    }
  }

  // Fetch transactions
  const orderIds = recentOrders
    .map((o) => o.shopifyOrderId)
    .filter(Boolean) as string[];

  const transactions = await prisma.creditTransaction.findMany({
    where: {
      companyId,
      orderId: { in: orderIds },
    },
    orderBy: { createdAt: "desc" },
  });

  const orderToBalanceMap = new Map();
  const orderToNotesMap = new Map();
  transactions.forEach((tx) => {
    if (tx.orderId && !orderToBalanceMap.has(tx.orderId)) {
      orderToBalanceMap.set(tx.orderId, tx.newBalance);
      orderToNotesMap.set(tx.orderId, tx.notes);
    }
  });

  const recentOrdersWithBalance = recentOrders.map((order) => ({
    ...order,
    // Use Shopify order name (#1008) if available, fallback to GID tail
    shopifyOrderName: order.shopifyOrderId
      ? (orderNameMap.get(order.shopifyOrderId) ??
        order.shopifyOrderId.split("/").pop() ??
        order.shopifyOrderId)
      : null,
    newBalance: order.shopifyOrderId
      ? orderToBalanceMap.get(order.shopifyOrderId) || order.remainingBalance
      : order.remainingBalance,
    notes: order.shopifyOrderId
      ? orderToNotesMap.get(order.shopifyOrderId)
      : null,
  }));

  // Get order statistics
  const [totalOrders, paidOrders, unpaidOrders, pendingOrders] =
    await Promise.all([
      prisma.b2BOrder.count({
        where: {
          companyId,
          orderStatus: { notIn: ["cancelled", "converted", "archived"] },
          shopifyOrderId: { not: null },
        },
      }),
      prisma.b2BOrder.count({
        where: {
          companyId,
          paymentStatus: "paid",
          orderStatus: { notIn: ["cancelled", "converted", "archived"] },
        },
      }),
      prisma.b2BOrder.count({
        where: {
          companyId,
          paymentStatus: { in: ["pending", "partial"] },
          orderStatus: { notIn: ["cancelled", "converted", "archived"] },
          shopifyOrderId: { not: null },
        },
      }),
      prisma.b2BOrder.count({
        where: {
          companyId,
          paymentStatus: { in: ["draft", "submitted", "processing"] },
        },
      }),
    ]);

  // Get users from database
  const dbUsers = await prisma.user.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      companyRole: true,
      status: true,
      createdAt: true,
      shopifyCustomerId: true, // Add this if you have it in your schema
    },
  });

  // Get Shopify customers
  const customersData = await getCompanyCustomers(
    company.shopifyCompanyId || "",
    shop,
    accessToken,
    {},
  );

  const shopifyCustomerMap = new Map<string, ShopifyCustomer>(
    customersData?.customers?.map((customer: ShopifyCustomer) => [
      customer.customer?.email?.toLowerCase() || "",
      customer,
    ]) || [],
  );

  const matchedUsers = dbUsers
    .map((user) => {
      const shopifyCustomer = shopifyCustomerMap.get(user.email.toLowerCase());

      return {
        ...user,
        shopifyCustomer: shopifyCustomer
          ? {
              id: shopifyCustomer.id,
              customerId: shopifyCustomer.customerId,
              displayName:
                `${shopifyCustomer.customer?.firstName || ""} ${shopifyCustomer.customer?.lastName || ""}`.trim(),
              email: shopifyCustomer.customer?.email,
              roles: shopifyCustomer.roles,
              locationNames: shopifyCustomer.locationNames,
            }
          : null,
        existsInShopify: !!shopifyCustomer,
      };
    })
    .filter((user) => user.existsInShopify);

  // Get total count of matched users
  const totalMatchedUsers = matchedUsers.length;

  return {
    company,
    recentOrders: recentOrdersWithBalance,
    orderStats: {
      total: totalOrders,
      paid: paidOrders,
      unpaid: unpaidOrders,
      pending: pendingOrders,
    },
    users: matchedUsers.slice(0, 10), // Return first 10 matched users
    totalUsers: totalMatchedUsers, // Return count of matched users
  };
}

/**
 * Get all users for a company
 */
export async function getCompanyUsers(companyId: string, shopId: string) {
  // Verify company belongs to shop
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: { shopId: true, name: true, shopifyCompanyId: true },
  });

  if (!company || company.shopId !== shopId) {
    return null;
  }

  const users = await prisma.user.findMany({
    where: { companyId, shopId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      companyRole: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    company,
    users,
  };
}

/**
 * Get all orders for a company via Shopify GraphQL
 */
export async function getCompanyOrders(
  companyId: string,
  shopId: string,
  accessToken: string,
) {
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: { shopId: true, name: true, shopifyCompanyId: true },
  });

  if (!company || company.shopId !== shopId) {
    return null;
  }

  const store = await prisma.store.findUnique({
    where: { id: shopId },
  });

  if (!store) {
    return null;
  }

  const shopName = store.shopDomain;
  const shopifyCompanyId = company.shopifyCompanyId || "";

  if (!shopifyCompanyId) {
    return {
      company,
      orders: [],
    };
  }

  try {
    const extractId = (id: string) => {
      if (!id) return "";
      return id.split("/").pop() || id;
    };

    const cleanCompanyId = extractId(shopifyCompanyId);

    console.log(
      "Querying company_id:",
      cleanCompanyId,
      "from:",
      shopifyCompanyId,
    );

    const query = `
      query getCompanyOrders($query: String!) {
        orders(query: $query, first: 250, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              updatedAt
              processedAt
              cancelledAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              currentTotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              totalRefundedSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              subtotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              totalTaxSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              totalShippingPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              shippingLines(first: 10) {
                edges {
                  node {
                    id
                    title
                    discountedPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    taxLines {
                      priceSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                    }
                  }
                }
              }
              customer {
                id
                firstName
                lastName
                email
                phone
              }
              purchasingEntity {
                ... on PurchasingCompany {
                  company {
                    id
                    name
                  }
                  location {
                    id
                    name
                  }
                }
              }
              note
              tags
              lineItems(first: 250) {
                edges {
                  node {
                    id
                    name
                    quantity
                    currentQuantity
                    originalUnitPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    discountedUnitPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    product {
                      id
                      title
                      handle
                    }
                    variant {
                      id
                      title
                      sku
                    }
                  }
                }
              }
              shippingAddress {
                firstName
                lastName
                company
                address1
                address2
                city
                province
                country
                zip
                phone
              }
              billingAddress {
                firstName
                lastName
                company
                address1
                address2
                city
                province
                country
                zip
                phone
              }
              customAttributes {
                key
                value
              }
            }
          }
        }
      }
    `;

    const queryString = `company_id:${cleanCompanyId}`;

    const response = await fetch(
      `https://${shopName}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query,
          variables: { query: queryString },
        }),
      },
    );

    const data = await response.json();

    if (data.errors) {
      console.error("GraphQL Errors:", data.errors);
      return {
        company,
        orders: [],
        error: data.errors[0].message,
      };
    }

    const ordersData = data.data?.orders;

    const processedOrders =
      ordersData?.edges
        ?.map((edge: any) => {
          const order = edge.node;

          let locationId = "";
          let locationName = "Company Order";

          if (order.purchasingEntity?.location) {
            locationId = order.purchasingEntity.location.id;
            locationName = order.purchasingEntity.location.name;
          } else if (
            order.billingAddress?.company ||
            order.shippingAddress?.company
          ) {
            locationName =
              order.billingAddress?.company || order.shippingAddress?.company;
          }

          const source =
            order.customAttributes?.find((attr: any) => attr.key === "_source")
              ?.value || null;

          return {
            ...order,
            locationId,
            locationName,
            source,
            // Extract numeric ID from GID for admin URL
            shopifyOrderNumericId: extractId(order.id),
            companyLocation: {
              id: locationId,
              name: locationName,
            },
          };
        })
        // Filter to ensure only orders belonging to this specific company
        .filter((order: any) => {
          const purchasingCompanyId = order.purchasingEntity?.company?.id;
          if (!purchasingCompanyId) return false;
          return extractId(purchasingCompanyId) === cleanCompanyId;
        }) || [];

    // Sync new orders to local database
    const userData = await prisma.user.findMany({
      where: { companyId },
      select: { id: true, email: true },
    });

    const emailToUserIdMap = new Map(
      userData.map((user) => [user.email, user.id]),
    );

    for (const order of processedOrders) {
      const shopifyOrderId = order.id;
      const customerEmail = order.customer?.email;
      const userId = customerEmail
        ? emailToUserIdMap.get(customerEmail)
        : undefined;

      try {
        const existingOrder = await prisma.b2BOrder.findUnique({
          where: { shopifyOrderId },
        });

        if (!existingOrder) {
          const orderData: any = {
            shopifyOrderId,
            company: { connect: { id: companyId } },
            shop: { connect: { id: shopId } },
            orderStatus: order.displayFulfillmentStatus || "unfulfilled",
            orderTotal: parseFloat(
              order.totalPriceSet?.shopMoney?.amount || "0",
            ),
            createdAt: new Date(order.createdAt),
            creditUsed: 0,
            userCreditUsed: 0,
            remainingBalance: 0,
          };

          if (userId) {
            orderData.createdByUser = { connect: { id: userId } };
          }

          await prisma.b2BOrder.create({
            data: orderData,
          });
        }
      } catch (error) {
        console.error(`Error syncing order ${shopifyOrderId}:`, error);
      }
    }

    return {
      company,
      orders: processedOrders,
    };
  } catch (error) {
    console.error("Error fetching company orders:", error);
    return {
      company,
      orders: [],
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

import { calculateAvailableCredit } from "./creditService";

/**
 * Update company credit limit and sync to Shopify metadata
 */
export async function updateCredit(
  form: FormData,
  admin?: AdminApiContext,
): Promise<{
  intent: string;
  success: boolean;
  message?: string;
  errors?: string[];
}> {
  const intent = "updateCredit";
  const id = (form.get("id") as string)?.trim();
  const creditRaw = (form.get("creditLimit") as string) || "0";
  const credit = parseCredit(creditRaw);
  const updatedBy = (form.get("updatedBy") as string) || "Admin";

  if (!id) {
    return {
      intent,
      success: false,
      errors: ["Company id is required"],
    };
  }
  if (!credit) {
    return {
      intent,
      success: false,
      errors: ["Credit must be a number"],
    };
  }

  try {
    // 1. Get current available credit before update
    const previousCreditInfo = await calculateAvailableCredit(id);
    if (!previousCreditInfo) {
      return {
        intent,
        success: false,
        errors: ["Company not found"],
      };
    }

    // 2. Update local database
    const updatedCompany = await prisma.companyAccount.update({
      where: { id },
      data: { creditLimit: credit },
    });

    // 3. Get new available credit after update
    const currentCreditInfo = await calculateAvailableCredit(id);
    if (!currentCreditInfo) {
      throw new Error("Failed to recalculate credit after update");
    }

    const previousBalance = previousCreditInfo.availableCredit;
    const newBalance = currentCreditInfo.availableCredit;
    const creditAmount = newBalance.minus(previousBalance);

    // 4. Record the transaction
    await prisma.creditTransaction.create({
      data: {
        companyId: updatedCompany.id,
        transactionType: "Credit Added",
        creditAmount: creditAmount,
        previousBalance: previousBalance,
        newBalance: newBalance,
        notes: `Credit limit updated from ${previousCreditInfo.creditLimit.toString()} to ${credit.toString()}`,
        createdBy: updatedBy,
        createdAt: new Date(),
      },
    });

    // 5. Sync to Shopify metadata if admin context is available and company has Shopify ID
    if (admin && updatedCompany.shopifyCompanyId) {
      try {
        await syncCompanyCreditMetafields(admin, updatedCompany.id);
        console.log(
          `✅ Successfully synced all credit metafields for company ${updatedCompany.id}`,
        );
      } catch (shopifyError) {
        console.error(
          "Failed to sync credit metafields to Shopify:",
          shopifyError,
        );
        // Continue execution - local update succeeded
      }
    }

    return {
      intent,
      success: true,
      message: "Credit updated",
    };
  } catch (error) {
    console.error("Error updating credit:", error);
    return {
      intent,
      success: false,
      errors: ["Failed to update credit limit"],
    };
  }
}

/**
 * Update or create a metafield on a Shopify company
 */
export async function updateCompanyMetafield(
  admin: AdminApiContext,
  shopifyCompanyId: string,
  metafield: {
    namespace: string;
    key: string;
    value: string;
    type: string;
  },
) {
  const mutation = `
    mutation CompanyMetafieldSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          key
          namespace
          value
          createdAt
          updatedAt
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: shopifyCompanyId,
        namespace: metafield.namespace,
        key: metafield.key,
        type: metafield.type,
        value: metafield.value,
      },
    ],
  };

  const response = await admin.graphql(mutation, {
    variables,
  });

  const data = (await response.json()) as any;

  if (data.errors || data.data?.metafieldsSet?.userErrors?.length > 0) {
    const errorMessage =
      data.errors?.[0]?.message ||
      data.data?.metafieldsSet?.userErrors?.[0]?.message ||
      "Unknown error occurred";
    throw new Error(`Failed to update company metafield: ${errorMessage}`);
  }

  return data.data.metafieldsSet.metafields[0];
}

/**
 * Get company metafield from Shopify
 */
export async function getCompanyMetafield(
  admin: AdminApiContext,
  shopifyCompanyId: string,
  namespace: string,
  key: string,
) {
  const normalizedId = shopifyCompanyId.startsWith("gid://")
    ? shopifyCompanyId
    : shopifyCompanyId.match(/(\d+)$/)
      ? `gid://shopify/Company/${shopifyCompanyId.match(/(\d+)$/)![1]}`
      : shopifyCompanyId;

  const query = `
    query CompanyMetafield($ownerId: ID!, $namespace: String!, $key: String!) {
      company(id: $ownerId) {
        metafield(namespace: $namespace, key: $key) {
          value
          type
          namespace
          key
          updatedAt
        }
      }
    }
  `;

  const variables = {
    ownerId: normalizedId,
    namespace,
    key,
  };

  const response = await admin.graphql(query, {
    variables,
  });

  const data = (await response.json()) as any;

  if (data.errors) {
    const errorMessage = data.errors[0]?.message || "Unknown error occurred";
    throw new Error(`Failed to get company metafield: ${errorMessage}`);
  }

  return data.data?.company?.metafield || null;
}

/**
 * Sync companies from Shopify to the database
 */
export async function syncCompaniesFromShopify(shopId: string, admin: any) {
  try {
    // GraphQL query to fetch all companies from Shopify
    const query = `
      query {
        companies(first: 250) {
          edges {
            node {
              id
              name
              externalId
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const response = await admin.graphql(query);
    const data = await response.json();

    if (data.errors) {
      const errorMessage = data.errors[0]?.message || "Unknown error occurred";
      throw new Error(`Failed to sync companies from Shopify: ${errorMessage}`);
    }

    const companies = data.data?.companies?.edges || [];
    let createdCount = 0;
    let updatedCount = 0;

    // Deduplicate companies by Shopify ID
    const seenShopifyIds = new Set<string>();
    const uniqueCompanies = companies.filter((edge: any) => {
      const shopifyId = edge.node.id.replace("gid://shopify/Company/", "");
      if (seenShopifyIds.has(shopifyId)) {
        console.log(
          `⚠️ Skipping duplicate company from Shopify: ${edge.node.name}`,
        );
        return false;
      }
      seenShopifyIds.add(shopifyId);
      return true;
    });

    // Get all existing companies to avoid creating duplicates by name
    const existingCompanies = await getCompaniesByShop(shopId);
    const existingCompanyNameMap = new Map<string, string>(); // normalized name -> id
    existingCompanies.forEach((comp) => {
      const normalizedName = comp.name.trim().toLowerCase();
      existingCompanyNameMap.set(normalizedName, comp.id);
    });

    // Upsert each company into the database
    for (const edge of uniqueCompanies) {
      const company = edge.node;
      const shopifyCompanyId = company.id;
      const normalizedName = company.name.trim().toLowerCase();

      try {
        // First, check if company with this Shopify ID already exists
        const existingByShopifyId = await getCompanyByShopifyId(
          shopId,
          shopifyCompanyId,
        );

        if (existingByShopifyId) {
          console.log(
            `ℹ️ Company already synced from Shopify: ${company.name}`,
          );
          updatedCount++;
          continue;
        }

        // Check if company with same name already exists (but no Shopify ID)
        const existingCompanyId = existingCompanyNameMap.get(normalizedName);

        if (existingCompanyId) {
          // Company with this name exists, update it with the Shopify ID
          console.log(
            `ℹ️ Linking Shopify ID to existing company: ${company.name}`,
          );
          try {
            await updateCompany(existingCompanyId, {
              shopifyCompanyId,
            });
            updatedCount++;
          } catch (updateError: any) {
            // If update fails due to unique constraint, skip it
            if (updateError?.code === "P2002") {
              console.log(
                `⚠️ Shopify ID already linked to another company: ${company.name}`,
              );
            } else {
              throw updateError;
            }
          }
          continue;
        }

        // Create new company with Shopify ID
        const result = await upsertCompany(shopId, shopifyCompanyId, {
          name: company.name,
        });

        createdCount++;
        existingCompanyNameMap.set(normalizedName, result.id);
      } catch (error) {
        console.error(`Failed to sync company ${company.name}:`, error);
      }
    }

    return {
      success: true,
      message: `Synced ${uniqueCompanies.length} unique companies from Shopify. Created: ${createdCount}, Updated: ${updatedCount}`,
      createdCount,
      updatedCount,
      totalSynced: uniqueCompanies.length,
    };
  } catch (error: any) {
    console.error("Error syncing companies from Shopify:", error);
    throw new Error(error.message || "Failed to sync companies from Shopify");
  }
}

/**
 * Sync companies and fetch their customers & locations from Shopify to ensure
 * dashboard data is current. This does not modify local company records
 * beyond what `syncCompaniesFromShopify` does — it simply queries Shopify
 * for each company to surface missing customers/locations and returns a
 * summary for the caller.
 */
export async function syncCompaniesAndDetails(shopId: string, admin: any) {
  // First, ensure company records are linked/created
  const syncResult = (await syncShopifyCompanies(
    admin,
    { id: shopId },
    null,
  )) as any;

  // Next, fetch store domain & access token to call helper functions that
  // use the REST/GraphQL Admin API via fetch
  const store = await prisma.store.findUnique({ where: { id: shopId } });
  if (!store) {
    return {
      success: false,
      message: "Store not found",
      createdCount: syncResult.createdCount || 0,
      updatedCount: syncResult.updatedCount || 0,
      totalSynced: syncResult.syncedCount || 0,
    };
  }

  const companies = await getCompaniesByShop(shopId);

  let companiesWithCustomers = 0;
  let companiesWithLocations = 0;
  let totalCustomers = 0;
  let totalLocations = 0;
  let companiesWithSyncedUsers = 0;
  let usersSynced = 0;
  let companiesWithSyncedOrders = 0;
  let ordersSynced = 0;
  const errors: string[] = [];

  for (const comp of companies) {
    const shopifyCompanyId = comp.shopifyCompanyId;
    if (!shopifyCompanyId) continue;

    const companyGid = shopifyCompanyId.startsWith("gid://")
      ? shopifyCompanyId
      : `gid://shopify/Company/${shopifyCompanyId}`;

    try {
      const customersData = await getCompanyCustomers(
        companyGid,
        store.shopDomain,
        store.accessToken || "",
        { first: 1 },
      );

      if (
        customersData &&
        Array.isArray(customersData.customers) &&
        customersData.customers.length > 0
      ) {
        companiesWithCustomers++;
        totalCustomers += customersData.customers.length;
      }

      const locationsData = await getCompanyLocations(
        companyGid,
        store.shopDomain,
        store.accessToken || "",
      );

      if (
        locationsData &&
        Array.isArray(locationsData.locations) &&
        locationsData.locations.length > 0
      ) {
        companiesWithLocations++;
        totalLocations += locationsData.locations.length;
      }

      const userSyncResult = await syncShopifyUsers(admin, store, comp.id);
      if (userSyncResult.success) {
        companiesWithSyncedUsers++;
        usersSynced += userSyncResult.syncedCount || 0;
      } else {
        errors.push(
          `Company ${comp.id} user sync failed: ${userSyncResult.message || userSyncResult.errors?.join(", ") || "unknown"}`,
        );
      }

      const orderSyncResult = await syncShopifyOrders(admin, store, comp.id);
      if (orderSyncResult.success) {
        companiesWithSyncedOrders++;
        ordersSynced += orderSyncResult.syncedCount || 0;
      } else {
        errors.push(
          `Company ${comp.id} order sync failed: ${orderSyncResult.message || orderSyncResult.errors?.join(", ") || "unknown"}`,
        );
      }
    } catch (err: any) {
      console.error(`Error fetching details for company ${comp.id}:`, err);
      errors.push(`Company ${comp.id}: ${err?.message || String(err)}`);
    }
  }

  return {
    success: true,
    message:
      `Synced companies. Companies with customers: ${companiesWithCustomers}, companies with locations: ${companiesWithLocations}, companies with user sync: ${companiesWithSyncedUsers}, companies with order sync: ${companiesWithSyncedOrders}` +
      (errors.length ? `; Errors: ${errors.join("; ")}` : ""),
    createdCount: 0,
    updatedCount: 0,
    totalSynced: syncResult.syncedCount || 0,
    companiesWithCustomers,
    companiesWithLocations,
    companiesWithSyncedUsers,
    usersSynced,
    companiesWithSyncedOrders,
    ordersSynced,
    errors,
    totalCustomers,
    totalLocations,
  };
}
