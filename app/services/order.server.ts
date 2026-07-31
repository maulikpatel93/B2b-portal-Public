import prisma from "../db.server";
import { Prisma } from "@prisma/client";

export interface OrderItemInput {
  productId?: string | null;
  productTitle: string;
  variantId?: string | null;
  variantTitle?: string | null;
  sku?: string | null;
  image?: string | null;
  quantity: number;
  unitPrice: number | Prisma.Decimal;
  discount?: number | Prisma.Decimal;
  lineTotal: number | Prisma.Decimal;
}

export interface CreateOrderInput {
  companyId: string;
  createdByUserId: string;
  shopId: string;
  shopifyOrderId?: string | null;
  orderTotal: number | Prisma.Decimal;
  creditUsed: number | Prisma.Decimal;
  userCreditUsed: number | Prisma.Decimal; // Add missing field
  remainingBalance: number | Prisma.Decimal;
  paidAmount?: number | Prisma.Decimal;
  paymentStatus?: string;
  orderStatus?: string;
  notes?: string; // Add optional notes field
  source?: string | null;
  userId?: string;
  // Shopify-sourced order details
  orderNumber?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerId?: string | null;
  currencyCode?: string | null;
  items?: OrderItemInput[];
}

/**
 * Map a Shopify REST/GraphQL financial status onto the Sales Portal's own
 * payment/order status vocabulary, along with derived paid/remaining amounts.
 * Falls back to a pending order for unknown/authorized/null statuses.
 */
export function mapShopifyFinancialStatus(
  financialStatus: string | null | undefined,
  orderTotal: number | Prisma.Decimal,
): {
  paymentStatus: string;
  orderStatus: string;
  paidAmount: Prisma.Decimal;
  remainingBalance: Prisma.Decimal;
} {
  const total = new Prisma.Decimal(orderTotal.toString());
  const zero = new Prisma.Decimal(0);
  const status = (financialStatus || "").toLowerCase();

  switch (status) {
    case "paid":
      return {
        paymentStatus: "paid",
        orderStatus: "completed",
        paidAmount: total,
        remainingBalance: zero,
      };
    case "partially_paid":
      return {
        paymentStatus: "partial",
        orderStatus: "processing",
        paidAmount: zero,
        remainingBalance: total,
      };
    case "refunded":
    case "partially_refunded":
      return {
        paymentStatus: "paid",
        orderStatus: "refunded",
        paidAmount: total,
        remainingBalance: zero,
      };
    case "voided":
      return {
        paymentStatus: "failed",
        orderStatus: "cancelled",
        paidAmount: zero,
        remainingBalance: total,
      };
    default:
      return {
        paymentStatus: "pending",
        orderStatus: "payment_pending",
        paidAmount: zero,
        remainingBalance: total,
      };
  }
}

function mapOrderItemsForCreate(items: OrderItemInput[] | undefined) {
  if (!items?.length) return undefined;
  return items.map((item) => ({
    productId: item.productId ?? null,
    productTitle: item.productTitle || item.variantTitle || "Product",
    variantId: item.variantId ?? null,
    variantTitle: item.variantTitle ?? null,
    sku: item.sku ?? null,
    image: item.image ?? null,
    quantity: item.quantity,
    unitPrice: new Prisma.Decimal(item.unitPrice.toString()),
    discount: new Prisma.Decimal((item.discount ?? 0).toString()),
    lineTotal: new Prisma.Decimal(item.lineTotal.toString()),
  }));
}

/**
 * Shared write-data for the Shopify-sourced detail fields. Only includes a
 * field when the caller supplied it, so existing callers stay unaffected.
 * When items are provided, existing line items are replaced.
 */
function buildOrderDetailData(
  data: CreateOrderInput,
): Prisma.B2BOrderUpdateInput {
  const detail: Prisma.B2BOrderUpdateInput = {};
  if (data.orderNumber !== undefined) detail.orderNumber = data.orderNumber;
  if (data.customerName !== undefined) detail.customerName = data.customerName;
  if (data.customerEmail !== undefined)
    detail.customerEmail = data.customerEmail;
  if (data.customerId !== undefined) detail.customerId = data.customerId;
  if (data.currencyCode) detail.currencyCode = data.currencyCode;
  const items = mapOrderItemsForCreate(data.items);
  if (items) detail.items = { deleteMany: {}, create: items };
  return detail;
}

export interface UpdateOrderInput {
  shopifyOrderId?: string | null;
  orderTotal?: number | Prisma.Decimal;
  creditUsed?: number | Prisma.Decimal;
  userCreditUsed?: number | Prisma.Decimal; // Add missing field
  paymentStatus?: string;
  orderStatus?: string;
  paidAmount?: number | Prisma.Decimal;
  remainingBalance?: number | Prisma.Decimal;
  paidAt?: Date | null;
  notes?: string; // Add optional notes field
  source?: string | null;
  updatedAt?: Date | null;
}

export interface CreateOrderPaymentInput {
  orderId: string;
  amount: number | Prisma.Decimal;
  method?: string | null;
  status?: string;
  receivedAt?: Date | null;
}

export interface UpdateOrderPaymentInput {
  amount?: number | Prisma.Decimal;
  method?: string | null;
  status?: string;
  receivedAt?: Date | null;
}

interface ConvertDraftOrderOptions {
  shopId?: string;
  companyId?: string;
  createdByUserId?: string;
  orderTotal?: number | string | Prisma.Decimal;
}

interface CreditSyncAdmin {
  graphql: (
    query: string,
    options?: { variables?: Record<string, string> },
  ) => Promise<Response>;
}

function uniqueOrderIds(ids: Array<string | null | undefined>) {
  return [...new Set(ids.filter(Boolean) as string[])];
}

function shopifyIdTail(id: string) {
  return id.split("/").pop() || id;
}

function draftOrderIdCandidates(shopifyOrderId: string) {
  const numericId = shopifyIdTail(shopifyOrderId);

  return uniqueOrderIds([
    shopifyOrderId,
    numericId,
    `gid://shopify/DraftOrder/${numericId}`,
  ]);
}

function shopifyOrderIdCandidates(shopifyOrderId: string) {
  const numericId = shopifyIdTail(shopifyOrderId);

  return uniqueOrderIds([
    shopifyOrderId,
    numericId,
    `gid://shopify/Order/${numericId}`,
    `gid://shopify/DraftOrder/${numericId}`,
  ]);
}

/**
 * Create or update B2B order (upsert functionality)
 * If order exists with same shopifyOrderId and companyId, update it
 * Otherwise create a new order
 */
export async function upsertOrder(data: CreateOrderInput) {
  if (!data.shopifyOrderId) {
    return await createOrder(data);
  }

  const existingOrder = await prisma.b2BOrder.findFirst({
    where: {
      shopId: data.shopId,
      shopifyOrderId: { in: shopifyOrderIdCandidates(data.shopifyOrderId) },
    },
  });

  if (existingOrder) {
    return await prisma.b2BOrder.update({
      where: { id: existingOrder.id },
      data: {
        companyId: data.companyId,
        createdByUserId: data.createdByUserId,
        shopId: data.shopId,
        shopifyOrderId: data.shopifyOrderId,
        orderTotal: new Prisma.Decimal(data.orderTotal.toString()),
        creditUsed: new Prisma.Decimal(data.creditUsed.toString()),
        userCreditUsed: new Prisma.Decimal(data.userCreditUsed.toString()),
        remainingBalance: new Prisma.Decimal(data.remainingBalance.toString()),
        ...(data.paidAmount !== undefined
          ? { paidAmount: new Prisma.Decimal(data.paidAmount.toString()) }
          : {}),
        paymentStatus: data.paymentStatus || "pending",
        orderStatus: data.orderStatus || "draft",
        notes: data.notes,
        source: data.source,
        ...buildOrderDetailData(data),
      },
      include: {
        company: true,
        createdByUser: true,
        payments: true,
      },
    });
  }

  try {
    return await createOrder(data);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existingOrder = await prisma.b2BOrder.findUnique({
        where: { shopifyOrderId: data.shopifyOrderId },
      });

      if (!existingOrder) {
        throw error;
      }

      return await prisma.b2BOrder.update({
        where: { id: existingOrder.id },
        data: {
          companyId: data.companyId,
          createdByUserId: data.createdByUserId,
          shopId: data.shopId,
          orderTotal: new Prisma.Decimal(data.orderTotal.toString()),
          creditUsed: new Prisma.Decimal(data.creditUsed.toString()),
          userCreditUsed: new Prisma.Decimal(data.userCreditUsed.toString()),
          remainingBalance: new Prisma.Decimal(data.remainingBalance.toString()),
          ...(data.paidAmount !== undefined
            ? { paidAmount: new Prisma.Decimal(data.paidAmount.toString()) }
            : {}),
          paymentStatus: data.paymentStatus || "pending",
          orderStatus: data.orderStatus || "draft",
          notes: data.notes,
          source: data.source,
          ...buildOrderDetailData(data),
        },
        include: {
          company: true,
          createdByUser: true,
          payments: true,
        },
      });
    }

    throw error;
  }
}

/**
 * Create a new B2B order
 */
export async function createOrder(data: CreateOrderInput) {
  const order = await prisma.b2BOrder.create({
    data: {
      companyId: data.companyId,
      createdByUserId: data.createdByUserId,
      shopId: data.shopId,
      shopifyOrderId: data.shopifyOrderId,
      orderTotal: new Prisma.Decimal(data.orderTotal.toString()),
      creditUsed: new Prisma.Decimal(data.creditUsed.toString()),
      userCreditUsed: new Prisma.Decimal(data.userCreditUsed.toString()), // Add missing field
      remainingBalance: new Prisma.Decimal(data.remainingBalance.toString()),
      paidAmount: new Prisma.Decimal(0),
      paymentStatus: data.paymentStatus || "pending",
      orderStatus: data.orderStatus || "draft",
      notes: data.notes, // Add optional notes field
      source: data.source,
    },
    include: {
      company: true,
      createdByUser: true,
      payments: true,
    },
  });
  const storeAdmin = await prisma.user.findFirst({
    where: {
      companyId: order?.companyId,
      role: "STORE_ADMIN",
    },
  });

  
    const notificationData = {
      message: `New B2B order created with ID: ${order.shopifyOrderId}`,
      title: "New Order Created",
      shopId: order?.shopId,
      activityType: "pending",
      senderId: order?.createdByUserId,
      shopifyOrderId:order.shopifyOrderId,
      receiverId: storeAdmin?.id,
      isRead: false,
      activeAction: order?.orderStatus,
    };
   const notifidationRecode= await prisma.notification.findFirst({
      where:{
        shopifyOrderId:order.shopifyOrderId
      }
    })
    
    if (notifidationRecode) {
      await prisma.notification.update({
        where: {
          id: notifidationRecode.id,
        },
        data: notificationData,
      });
    } else {
      await prisma.notification.create({
        data: notificationData,
      });
    }
  

  return order;
}

/**
 * Get order by ID
 */
export async function getOrderById(id: string) {
  return await prisma.b2BOrder.findUnique({
    where: { id },
    include: {
      company: true,
      createdByUser: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      payments: true,
    },
  });
}

/**
 * Get order by Shop ID and Shopify Order GID (used by webhooks)
 */
export async function getOrderByShopifyId(
  shopId: string,
  shopifyOrderId: string,
) {
  return await prisma.b2BOrder.findFirst({
    where: {
      shopId,
      shopifyOrderId: { in: shopifyOrderIdCandidates(shopifyOrderId) },
    },
    select: {
      id: true,
      orderTotal: true,
      companyId: true,
      remainingBalance: true,
      paidAmount: true,
      paidAt: true,
      creditUsed: true,
      userCreditUsed: true,
      paymentStatus: true,
      orderStatus: true,
    },
  });
}

/**
 * Get complete order details by Shop ID and Shopify Order GID with all relations
 */
export async function getOrderByShopifyIdWithDetails(
  shopId: string,
  shopifyOrderId: string,
) {
  return await prisma.b2BOrder.findFirst({
    where: {
      shopId,
      shopifyOrderId: { in: shopifyOrderIdCandidates(shopifyOrderId) },
    },
    include: {
      company: {},
      createdByUser: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      payments: true,
      shop: true,
    },
  });
}

/**
 * Get orders by company
 */
export async function getOrdersByCompany(
  companyId: string,
  options?: {
    orderStatus?: string | string[];
    paymentStatus?: string | string[];
    orderBy?: Prisma.B2BOrderOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  const where: Prisma.B2BOrderWhereInput = {
    companyId,
  };

  if (options?.orderStatus) {
    where.orderStatus = Array.isArray(options.orderStatus)
      ? { in: options.orderStatus }
      : options.orderStatus;
  }

  if (options?.paymentStatus) {
    where.paymentStatus = Array.isArray(options.paymentStatus)
      ? { in: options.paymentStatus }
      : options.paymentStatus;
  }

  return await prisma.b2BOrder.findMany({
    where,
    orderBy: options?.orderBy || { createdAt: "desc" },
    take: options?.take,
    skip: options?.skip,
    include: {
      company: true,
      createdByUser: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      payments: true,
    },
  });
}

/**
 * Get orders by user
 */
export async function getOrdersByUser(
  userId: string,
  options?: {
    orderStatus?: string | string[];
    orderBy?: Prisma.B2BOrderOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  const where: Prisma.B2BOrderWhereInput = {
    createdByUserId: userId,
  };

  if (options?.orderStatus) {
    where.orderStatus = Array.isArray(options.orderStatus)
      ? { in: options.orderStatus }
      : options.orderStatus;
  }

  return await prisma.b2BOrder.findMany({
    where,
    orderBy: options?.orderBy || { createdAt: "desc" },
    take: options?.take,
    skip: options?.skip,
    include: {
      company: true,
      payments: true,
    },
  });
}

/**
 * Update an order
 */
export async function updateOrder(id: string, data: UpdateOrderInput) {
  const updateData: Prisma.B2BOrderUpdateInput = {
    ...data,
    updatedAt: new Date(),
  };

  // Convert numeric fields to Decimal
  if (data.orderTotal !== undefined) {
    updateData.orderTotal = new Prisma.Decimal(data.orderTotal.toString());
  }
  if (data.creditUsed !== undefined) {
    updateData.creditUsed = new Prisma.Decimal(data.creditUsed.toString());
  }
  if (data.userCreditUsed !== undefined) {
    updateData.userCreditUsed = new Prisma.Decimal(
      data.userCreditUsed.toString(),
    );
  }
  if (data.paidAmount !== undefined) {
    updateData.paidAmount = new Prisma.Decimal(data.paidAmount.toString());
  }
  if (data.remainingBalance !== undefined) {
    updateData.remainingBalance = new Prisma.Decimal(
      data.remainingBalance.toString(),
    );
  }

  return await prisma.b2BOrder.update({
    where: { id },
    data: updateData,
    include: {
      company: true,
      createdByUser: true,
      payments: true,
    },
  });
}

/**
 * Delete an order
 */
export async function deleteOrder(id: string) {
  return await prisma.b2BOrder.delete({
    where: { id },
  });
}

/**
 * Count orders
 */
export async function countOrders(where: Prisma.B2BOrderWhereInput) {
  return await prisma.b2BOrder.count({ where });
}

/**
 * Count orders by company
 */
export async function countOrdersByCompany(
  companyId: string,
  options?: {
    orderStatus?: string | string[];
    paymentStatus?: string | string[];
  },
) {
  const where: Prisma.B2BOrderWhereInput = {
    companyId,
  };

  if (options?.orderStatus) {
    where.orderStatus = Array.isArray(options.orderStatus)
      ? { in: options.orderStatus }
      : options.orderStatus;
  }

  if (options?.paymentStatus) {
    where.paymentStatus = Array.isArray(options.paymentStatus)
      ? { in: options.paymentStatus }
      : options.paymentStatus;
  }

  return await countOrders(where);
}

/**
 * Create an order payment
 */
export async function createOrderPayment(data: CreateOrderPaymentInput) {
  return await prisma.orderPayment.create({
    data: {
      orderId: data.orderId,
      amount: new Prisma.Decimal(data.amount.toString()),
      method: data.method,
      status: data.status || "pending",
      receivedAt: data.receivedAt,
    },
  });
}

/**
 * Get payment by ID
 */
export async function getPaymentById(id: string) {
  return await prisma.orderPayment.findUnique({
    where: { id },
    include: {
      order: true,
    },
  });
}

/**
 * Get payments by order
 */
export async function getPaymentsByOrder(orderId: string) {
  return await prisma.orderPayment.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Update an order payment
 */
export async function updateOrderPayment(
  id: string,
  data: UpdateOrderPaymentInput,
) {
  const updateData: Prisma.OrderPaymentUpdateInput = {
    ...data,
    updatedAt: new Date(),
  };

  if (data.amount !== undefined) {
    updateData.amount = new Prisma.Decimal(data.amount.toString());
  }

  return await prisma.orderPayment.update({
    where: { id },
    data: updateData,
  });
}

/**
 * Delete an order payment
 */
export async function deleteOrderPayment(id: string) {
  return await prisma.orderPayment.delete({
    where: { id },
  });
}

/**
 * Convert a draft order into a final order by marking it as converted/archived
 * and releasing its credit so it is not double counted.
 */
export async function convertDraftOrderToFinal(
  draftShopifyOrderId: string,
  finalShopifyOrderId: string,
  admin?: CreditSyncAdmin,
  options: ConvertDraftOrderOptions = {},
) {
  console.log(`🔄 Converting draft order ${draftShopifyOrderId} to final order ${finalShopifyOrderId}`);

  // 1. Find the draft order in database
  let draftOrder = await prisma.b2BOrder.findFirst({
    where: {
      shopifyOrderId: { in: draftOrderIdCandidates(draftShopifyOrderId) },
    },
  });

  if (!draftOrder && options.shopId && options.companyId) {
    const fallbackWhere: Prisma.B2BOrderWhereInput = {
      shopId: options.shopId,
      companyId: options.companyId,
      createdByUserId: options.createdByUserId,
      paymentStatus: { in: ["pending", "partial"] },
      orderStatus: { in: ["draft", "submitted", "processing"] },
      OR: [
        { shopifyOrderId: null },
        { shopifyOrderId: { notIn: shopifyOrderIdCandidates(finalShopifyOrderId) } },
      ],
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    };

    if (options.orderTotal !== undefined) {
      fallbackWhere.orderTotal = new Prisma.Decimal(options.orderTotal.toString());
    }

    draftOrder = await prisma.b2BOrder.findFirst({
      where: fallbackWhere,
      orderBy: { createdAt: "desc" },
    });

    if (draftOrder) {
      console.log(`✅ Matched draft order by recent company/order total fallback: ${draftOrder.id}`);
    }
  }

  if (!draftOrder) {
    console.log(`⚠️ No local draft order found for shopifyOrderId: ${draftShopifyOrderId}`);
    return null;
  }

  // 2. If it's already converted/archived, do nothing
  if (draftOrder.orderStatus === "converted" || draftOrder.orderStatus === "archived") {
    console.log(`⚠️ Draft order ${draftOrder.id} is already ${draftOrder.orderStatus}`);
    return draftOrder;
  }

  // 3. Restore user credit if userCreditUsed was set on the draft order
  if (draftOrder.userCreditUsed && parseFloat(draftOrder.userCreditUsed.toString()) > 0) {
    console.log(`🏦 Restoring user credit: ${draftOrder.userCreditUsed} for converted draft order`);
    await prisma.user.update({
      where: { id: draftOrder.createdByUserId },
      data: {
        userCreditUsed: {
          decrement: draftOrder.userCreditUsed,
        },
      },
    });
  }

  // 4. Update all credit transactions associated with this draft order:
  // - Mark transactionType as "order_converted"
  // - Set creditAmount to 0 so it doesn't count in sums
  // - Add a note indicating it was converted to the final order
  const orderIdentifiers = [
    draftOrder.id,
    draftOrder.shopifyOrderId,
    ...draftOrderIdCandidates(draftShopifyOrderId),
  ].filter(Boolean) as string[];

  await prisma.creditTransaction.updateMany({
    where: {
      companyId: draftOrder.companyId,
      orderId: { in: orderIdentifiers },
    },
    data: {
      transactionType: "order_converted",
      creditAmount: new Prisma.Decimal(0),
      notes: `Draft order converted to final order ${finalShopifyOrderId}`,
    },
  });

  // 5. Update the B2BOrder itself
  // - Mark orderStatus as "converted"
  // - Zero out credit fields so they don't count towards company totals
  const updatedDraftOrder = await prisma.b2BOrder.update({
    where: { id: draftOrder.id },
    data: {
      orderStatus: "converted",
      orderTotal: new Prisma.Decimal(0),
      creditUsed: new Prisma.Decimal(0),
      userCreditUsed: new Prisma.Decimal(0),
      remainingBalance: new Prisma.Decimal(0),
      notes: `Converted to final order ${finalShopifyOrderId}. Original total: ${draftOrder.orderTotal}`,
    },
  });

  console.log(`✅ Successfully converted draft order ${draftOrder.id} to converted status`);

  if (admin) {
    try {
      const { syncCompanyCreditMetafields } = await import("./metafieldSync.server");
      await syncCompanyCreditMetafields(admin, draftOrder.companyId);
      console.log(`✅ Synced metafields after converting draft order for company ${draftOrder.companyId}`);
    } catch (syncError) {
      console.error(`⚠️ Failed to sync metafields after converting draft order:`, syncError);
    }
  }

  return updatedDraftOrder;
}
