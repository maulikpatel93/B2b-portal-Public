import prisma from "../db.server";
import { Prisma, UserRole, UserStatus } from "@prisma/client";

export interface CreateUserInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  password: string; // Should be hashed before passing to this function
  role?: UserRole;
  status?: UserStatus;
  shopId: string; // Required for public app - every user must be assigned to a shop
  companyId?: string | null;
  companyRole?: string | null;
  shopifyCustomerId?: string | null; // Shopify customer GID for linking
  userCreditLimit?: number | null;
}

export interface UpdateUserInput {
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  password?: string; // Should be hashed before passing to this function
  role?: UserRole;
  status?: UserStatus;
  isActive?: boolean;
  shopId?: string; // Optional in updates, but if provided must be valid shop
  companyId?: string | null;
  companyRole?: string | null;
  userCreditLimit?: number | null;
}

export interface CreateUserSessionInput {
  token: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Create a new user
 */
export async function createUser(data: CreateUserInput) {
  return await prisma.user.create({
    data: {
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      password: data.password,
      role: data.role || "STORE_USER",
      status: data.status || "PENDING",
      shopId: data.shopId,
      companyId: data.companyId,
      companyRole: data.companyRole,
      shopifyCustomerId: data.shopifyCustomerId,
      isActive: true,
      userCreditLimit: data.userCreditLimit || 0,
    },
    include: {
      shop: true,
      company: true,
    },
  });
}

/**
 * Get user by ID with shop isolation
 */
export async function getUserById(id: string, shopId: string) {
  return await prisma.user.findFirst({
    where: {
      shopifyCustomerId: id,
      shopId, // Ensure user belongs to the requesting shop
    },
    include: {
      shop: true,
      company: true,
      sessions: true,
    },
  });
}

/**
 * Get user by email within a specific shop.
 * Optionally scope by role when the same email can exist under multiple roles.
 */
export async function getUserByEmail(
  email: string,
  shopId: string,
  role?: UserRole,
) {
  return await prisma.user.findFirst({
    where: {
      email: email.trim().toLowerCase(),
      shopId,
      ...(role ? { role } : {}),
    },
    include: {
      shop: true,
      company: true,
    },
  });
}

/**
 * Get users by shop
 */
export async function getUsersByShop(
  shopId: string,
  options?: {
    role?: UserRole;
    status?: UserStatus;
    isActive?: boolean;
    orderBy?: Prisma.UserOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  const where: Prisma.UserWhereInput = {
    shopId,
  };

  if (options?.role) {
    where.role = options.role;
  }
  if (options?.status) {
    where.status = options.status;
  }
  if (options?.isActive !== undefined) {
    where.isActive = options.isActive;
  }

  return await prisma.user.findMany({
    where,
    orderBy: options?.orderBy || { createdAt: "desc" },
    take: options?.take,
    skip: options?.skip,
    include: {
      company: true,
    },
  });
}

/**
 * Get users by company within a specific shop
 */
export async function getUsersByCompany(
  companyId: string,
  shopId: string,
  options?: {
    companyRole?: string;
    status?: UserStatus;
    orderBy?: Prisma.UserOrderByWithRelationInput;
  },
) {
  const where: Prisma.UserWhereInput = {
    companyId,
    shopId, // Ensure users belong to the requesting shop
  };

  if (options?.companyRole) {
    where.companyRole = options.companyRole;
  }
  if (options?.status) {
    where.status = options.status;
  }

  return await prisma.user.findMany({
    where,
    orderBy: options?.orderBy || { createdAt: "desc" },
    include: {
      shop: true,
    },
  });
}

/**
 * Update a user with shop validation
 */
export async function updateUser(
  id: string,
  shopId: string,
  data: UpdateUserInput,
) {
  // First verify the user belongs to the shop
  const existingUser = await prisma.user.findFirst({
    where: { id, shopId },
    select: { id: true },
  });

  if (!existingUser) {
    throw new Error("User not found or does not belong to this shop");
  }

  return await prisma.user.update({
    where: { id },
    data: {
      ...data,
      updatedAt: new Date(),
    },
    include: {
      shop: true,
      company: true,
    },
  });
}

/**
 * Delete a user with shop validation
 */
export async function deleteUser(id: string, shopId: string) {
  // First verify the user belongs to the shop
  const existingUser = await prisma.user.findFirst({
    where: { id, shopId },
    select: { id: true },
  });

  if (!existingUser) {
    throw new Error("User not found or does not belong to this shop");
  }

  const deleteResult = await prisma.user.deleteMany({
    where: { id, shopId },
  });

  if (deleteResult.count === 0) {
    throw new Error("User not found or does not belong to this shop");
  }

  return { success: true };
}

/**
 * Count users
 */
export async function countUsers(where: Prisma.UserWhereInput) {
  return await prisma.user.count({ where });
}

/**
 * Count users by shop
 */
export async function countUsersByShop(
  shopId: string,
  options?: {
    role?: UserRole;
    status?: UserStatus;
  },
) {
  const where: Prisma.UserWhereInput = {
    shopId,
  };

  if (options?.role) {
    where.role = options.role;
  }
  if (options?.status) {
    where.status = options.status;
  }

  return await countUsers(where);
}

/**
 * Create a user session
 */
export async function createUserSession(data: CreateUserSessionInput) {
  return await prisma.userSession.create({
    data: {
      token: data.token,
      userId: data.userId,
      expiresAt: data.expiresAt,
    },
  });
}

/**
 * Get session by token
 */
export async function getSessionByToken(token: string) {
  return await prisma.userSession.findUnique({
    where: { token },
    include: {
      user: {
        include: {
          shop: true,
          company: true,
        },
      },
    },
  });
}

/**
 * Delete a session
 */
export async function deleteSession(token: string) {
  return await prisma.userSession.delete({
    where: { token },
  });
}

/**
 * Delete expired sessions for a user
 */
export async function deleteExpiredSessions(userId: string) {
  return await prisma.userSession.deleteMany({
    where: {
      userId,
      expiresAt: {
        lt: new Date(),
      },
    },
  });
}

/**
 * Delete all sessions for a user
 */
export async function deleteAllUserSessions(userId: string) {
  return await prisma.userSession.deleteMany({
    where: { userId },
  });
}

/**
 * Get active approved user by shop and Shopify customer ID
 */
export async function getUserByShopifyCustomerId(
  shopId: string,
  shopifyCustomerId: string,
) {
  return await prisma.user.findFirst({
    where: {
      shopId,
      shopifyCustomerId,
      isActive: true,
      status: "APPROVED",
    },
    select: { id: true, companyId: true },
  });
}

/* get user comny by the id */
export async function getCompanyByUserId(
  shopId: string,
  shopifyCustomerId: string,
) {
  return await prisma.user.findFirst({
    where: {
      shopId,
      shopifyCustomerId,
      isActive: true,
      status: "APPROVED",
    },
    include: {
      company: true,
    },
  });
}

/**
 * Get user by ID across all shops (for super admin use cases)
 */
export async function getUserByIdGlobal(id: string) {
  return await prisma.user.findUnique({
    where: { id },
    include: {
      shop: true,
      company: true,
      sessions: true,
    },
  });
}

/**
 * Validate session and get user with optional shop validation
 */
export async function validateSession(token: string, expectedShopId?: string) {
  const session = await getSessionByToken(token);

  if (!session) {
    return null;
  }

  if (session.expiresAt < new Date()) {
    await deleteSession(token);
    return null;
  }

  // If expectedShopId is provided, validate user belongs to that shop
  if (expectedShopId && session.user.shopId !== expectedShopId) {
    return null;
  }

  return session.user;
}
