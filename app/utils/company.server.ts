import { Prisma, UserRole, UserStatus } from "@prisma/client";
import prisma from "../db.server";
import { sendCompanyWelcomeEmail } from "../services/notification.server";
import { Decimal } from "@prisma/client/runtime/library";
import { FREE_PLAN_MAX_COMPANIES } from "./free-plan-limits.server";
import { getCompanyLocations } from "./b2b-customer.server";

type ShopifyAdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{
    json: () => Promise<any>;
  }>;
};

type StoreRef = {
  id: string;
};

type ShopifyCustomerNode = {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  companyContactProfiles?: Array<{
    id: string;
    title?: string | null;
    company?: {
      id: string;
      name?: string | null;
      mainContact?: {
        id: string;
        customer?: {
          id: string;
        } | null;
      } | null;
    } | null;
    roleAssignments?: {
      edges: ShopifyRoleAssignment[];
    } | null;
  }> | null;
};

const EMPTY_ADDRESS_JSON: Prisma.JsonObject = {};

/**
 * Sync Shopify B2B companies to local database
 * Fetches all companies from Shopify, imports contact data, and sends notifications
 * SERVER ONLY - Uses Prisma and admin context
 */

type ShopifyCompanyNode = {
  id: string;
  name: string;
  externalId?: string;
  mainContact?: {
    id: string;
    customer?: {
      id: string;
      email?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
    };
  };
  contacts?: {
    nodes: Array<{
      id: string;
      customer?: {
        id: string;
        email?: string;
        firstName?: string;
        lastName?: string;
        phone?: string;
      };
    }>;
  };
  locations?: {
    nodes: Array<{
      id: string;
      name: string;
      shippingAddress?: ShopifyCompanyAddress | null;
      billingAddress?: ShopifyCompanyAddress | null;
    }>;
  };
};

type ShopifyCompanyAddress = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
};

const mapShopifyAddressToRegistrationJson = (
  address?: ShopifyCompanyAddress | null,
): Prisma.JsonObject => {
  if (!address) return EMPTY_ADDRESS_JSON;

  const mapped = {
    Addr1: address.address1 || "",
    Addr2: address.address2 || "",
    City: address.city || "",
    State: address.province || "",
    Zip: address.zip || "",
    Country: address.country || "",
    FirstName: address.firstName || "",
    LastName: address.lastName || "",
    Phone: address.phone || "",
  } satisfies Prisma.JsonObject;

  const hasAnyValue = Object.values(mapped).some(
    (value) => typeof value === "string" && value.trim() !== "",
  );

  return hasAnyValue ? mapped : EMPTY_ADDRESS_JSON;
};

export const syncShopifyCompanies = async (
  admin: ShopifyAdminClient,
  store: StoreRef,
  submissionEmail: string | null,
) => {
  try {
    const storeSettings = await prisma.store.findUnique({
      where: { id: store.id },
      select: { defaultCompanyCreditLimit: true, plan: true },
    });
    const defaultCompanyCreditLimit =
      storeSettings?.defaultCompanyCreditLimit ?? new Prisma.Decimal(0);
    const isFreePlan = storeSettings?.plan === "free";

    // Step 1: Fetch all Shopify B2B companies with pagination
    let allCompanies: ShopifyCompanyNode[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const companiesQuery = `
        query GetAllCompanies($cursor: String) {
          companies(first: 100, after: $cursor) {
            nodes {
              id
              name
              externalId
              mainContact {
                id
                customer {
                  id
                  email
                  firstName
                  lastName
                  phone
                }
              }
              contacts(first: 10) {
                nodes {
                  id
                  customer {
                    id
                    email
                    firstName
                    lastName
                    phone
                  }
                }
              }
              locations(first: 1) {
                nodes {
                  id
                  name
                  shippingAddress {
                    address1
                    address2
                    city
                    province
                    zip
                    country
                    firstName
                    lastName
                    phone
                  }
                  billingAddress {
                    address1
                    address2
                    city
                    province
                    zip
                    country
                    firstName
                    lastName
                    phone
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const response = await admin.graphql(companiesQuery, {
        variables: { cursor },
      });
      const result = await response.json();
      const data = result?.data?.companies;

      if (data?.nodes) {
        allCompanies = [...allCompanies, ...data.nodes];
      }

      hasNextPage = data?.pageInfo?.hasNextPage || false;
      cursor = data?.pageInfo?.endCursor || null;
    }

    // Free plan: cap at the allowed number of companies
    if (isFreePlan && allCompanies.length > FREE_PLAN_MAX_COMPANIES) {
      allCompanies = allCompanies.slice(0, FREE_PLAN_MAX_COMPANIES);
    }

    let syncedCount = 0;
    const errors: string[] = [];
    const shopifyCompanyIds = allCompanies.map((company) => company.id);

    // Step 2-5: Process each company
    for (const company of allCompanies) {
      try {
        const companyName = company.name;
        const primaryLocation = company.locations?.nodes?.[0];
        const shippingAddressJson = mapShopifyAddressToRegistrationJson(
          primaryLocation?.shippingAddress,
        );
        const billingAddressJson = mapShopifyAddressToRegistrationJson(
          primaryLocation?.billingAddress,
        );

        const effectiveContact = (() => {
          if (company.mainContact?.customer?.email) {
            return company.mainContact.customer;
          }
          const fallback = company.contacts?.nodes?.find(
            (c) => c.customer?.email,
          );
          if (fallback?.customer) {
            console.log(
              `Company "${companyName}" has no mainContact email — using fallback contact: ${fallback.customer.email}`,
            );
            return fallback.customer;
          }
          return null;
        })();

        const existingSyncedCompany = await prisma.companyAccount.findUnique({
          where: {
            shopId_shopifyCompanyId: {
              shopId: store.id,
              shopifyCompanyId: company.id,
            },
          },
        });

        const existingLocalCompanyByName = existingSyncedCompany
          ? null
          : await prisma.companyAccount.findFirst({
              where: {
                shopId: store.id,
                name: companyName,
              },
              orderBy: {
                updatedAt: "desc",
              },
            });

        const companyUpdateData = {
          name: companyName,
          shopifyCompanyId: company.id,
          ...(effectiveContact && {
            ...(effectiveContact.firstName && {
              contactName:
                `${effectiveContact.firstName} ${effectiveContact.lastName || ""}`.trim(),
            }),
            contactEmail: effectiveContact.email || null,
          }),
        };

        // Reuse an existing local company row when possible so custom
        // payment terms and credit limits survive a sync.
        const upsertedCompany = existingSyncedCompany
          ? await prisma.companyAccount.update({
              where: { id: existingSyncedCompany.id },
              data: companyUpdateData,
            })
          : existingLocalCompanyByName
            ? await prisma.companyAccount.update({
                where: { id: existingLocalCompanyByName.id },
                data: companyUpdateData,
              })
            : await prisma.companyAccount.create({
                data: {
                  shopId: store.id,
                  shopifyCompanyId: company.id,
                  name: companyName,
                  contactName: effectiveContact?.firstName
                    ? `${effectiveContact.firstName} ${effectiveContact.lastName || ""}`.trim()
                    : null,
                  contactEmail: effectiveContact?.email || null,
                  creditLimit: new Prisma.Decimal(
                    defaultCompanyCreditLimit.toString(),
                  ),
                },
              });

        // User + registration sync only if we have an email
        if (effectiveContact?.email) {
          const shopifyCustomerId = effectiveContact.id;

          const existingRegistration =
            await prisma.registrationSubmission.findFirst({
              where: {
                shopId: store.id,
                OR: [{ email: effectiveContact.email }, { shopifyCustomerId }],
              },
              select: { id: true, status: true },
            });

          if (
            existingRegistration &&
            existingRegistration.status !== UserStatus.APPROVED
          ) {
            const existingLocalCompany = await prisma.companyAccount.findUnique(
              {
                where: {
                  shopId_shopifyCompanyId: {
                    shopId: store.id,
                    shopifyCompanyId: company.id,
                  },
                },
                select: {
                  id: true,
                  _count: {
                    select: {
                      orders: true,
                    },
                  },
                },
              },
            );

            if (
              existingLocalCompany &&
              existingLocalCompany._count.orders === 0
            ) {
              await prisma.companyAccount.delete({
                where: { id: existingLocalCompany.id },
              });
            }

            continue;
          }

          await prisma.user.upsert({
            where: {
              shopId_email_role: {
                shopId: store.id,
                email: effectiveContact.email,
                role: UserRole.STORE_ADMIN,
              },
            },
            update: {
              // ✅ Only overwrite firstName/lastName if Shopify provides a real value
              ...(effectiveContact.firstName && {
                firstName: effectiveContact.firstName,
              }),
              ...(effectiveContact.lastName && {
                lastName: effectiveContact.lastName,
              }),
              shopifyCustomerId,
              shopId: store.id,
              companyId: upsertedCompany.id,
              companyRole: "admin",
              role: UserRole.STORE_ADMIN,
              isActive: true,
            },
            create: {
              email: effectiveContact.email,
              firstName: effectiveContact.firstName || null,
              lastName: effectiveContact.lastName || null,
              password: "",
              shopifyCustomerId,
              shopId: store.id,
              companyId: upsertedCompany.id,
              companyRole: "admin",
              role: UserRole.STORE_ADMIN,
              status: UserStatus.APPROVED,
              isActive: true,
            },
          });

          if (existingRegistration) {
            if (existingRegistration.status !== UserStatus.REJECTED) {
              await prisma.registrationSubmission.update({
                where: { id: existingRegistration.id },
                data: {
                  email: effectiveContact.email,
                  companyName: upsertedCompany.name,
                  // ✅ Only overwrite firstName/lastName if Shopify provides a real value
                  ...(effectiveContact.firstName && {
                    firstName: effectiveContact.firstName,
                  }),
                  ...(effectiveContact.lastName && {
                    lastName: effectiveContact.lastName,
                  }),
                  shopifyCustomerId,
                  location: {
                    shipping: shippingAddressJson,
                    billing: billingAddressJson,
                  },
                  shopId: store.id,
                },
              });
            }
          } else {
            await prisma.registrationSubmission.create({
              data: {
                email: effectiveContact.email,
                companyName: upsertedCompany.name,
                firstName: effectiveContact.firstName || "",
                lastName: effectiveContact.lastName || "",
                shopifyCustomerId,
                status: UserStatus.APPROVED,
                shopId: store.id,
                contactTitle: "",
                location: {
                  shipping: shippingAddressJson,
                  billing: billingAddressJson,
                },
                workflowCompleted: true,
              },
            });
          }

          await syncShopifyUsers(admin, store, upsertedCompany.id);

          if (
            submissionEmail &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submissionEmail)
          ) {
            // try {
            //   await sendCompanyWelcomeEmail(
            //     submissionEmail,
            //     companyName,
            //     effectiveContact.firstName || "Customer",
            //   );
            // } catch (emailError) {
            //   console.error("Failed to send email:", emailError);
            // }
          }
        } else {
          // No contact email found — still sync orders, skip user sync
          // await syncShopifyOrders(admin, store, upsertedCompany.id);
          // console.warn(
          //   `Company "${companyName}" has no contacts with email — skipping user sync`,
          // );
        }

        syncedCount++;
      } catch (companyError) {
        console.error(`Error syncing company:`, companyError);
        errors.push(
          `Failed to sync ${company.name}: ${companyError instanceof Error ? companyError.message : "Unknown error"}`,
        );
      }
    }

    // Step 6: Delete companies that don't exist in Shopify anymore
    try {
      const deleteResult = await prisma.companyAccount.deleteMany({
        where: {
          shopId: store.id,
          shopifyCompanyId: {
            not: null,
            notIn: shopifyCompanyIds,
          },
        },
      });

      console.log(
        `Deleted ${deleteResult.count} companies that no longer exist in Shopify`,
      );

      if (deleteResult.count > 0) {
        return {
          success: true,
          syncedCount,
          deletedCount: deleteResult.count,
          errors,
          message:
            errors.length > 0
              ? `Synced ${syncedCount} companies, deleted ${deleteResult.count} companies with ${errors.length} errors`
              : `Successfully synced ${syncedCount} companies and deleted ${deleteResult.count} obsolete companies`,
        };
      }
    } catch (deleteError) {
      console.error("Error deleting obsolete companies:", deleteError);
      errors.push(
        `Failed to delete obsolete companies: ${deleteError instanceof Error ? deleteError.message : "Unknown error"}`,
      );
    }

    return {
      success: true,
      syncedCount,
      deletedCount: 0,
      errors,
      message:
        errors.length > 0
          ? `Synced ${syncedCount} companies with ${errors.length} errors`
          : `Successfully synced ${syncedCount} companies`,
    };
  } catch (error) {
    console.error("Sync error:", error);
    return {
      success: false,
      syncedCount: 0,
      deletedCount: 0,
      errors: [
        error instanceof Error ? error.message : "Unknown sync error occurred",
      ],
      message: "Sync failed",
    };
  }
};

/**
 * Parse form data from request
 * SERVER ONLY
 */
export const parseForm = async (request: Request) => {
  const formData = await request.formData();
  return Object.fromEntries(formData);
};

/**
 * Parse and validate credit limit value
 */
export const parseCredit = (value?: string) => {
  if (!value) return new Prisma.Decimal(0);
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return new Prisma.Decimal(numeric);
};

interface ShopifyRoleAssignment {
  node: {
    role: {
      name: string;
    };
  };
}
/**
 * Sync Shopify B2B customers/users to local database
 * Fetches customers with B2B access, creates/updates User records
 * SERVER ONLY - Uses Prisma and admin context
 */
export const syncShopifyUsers = async (
  admin: ShopifyAdminClient,
  store: StoreRef,
  companyId?: string,
) => {
  try {
    let targetShopifyCompanyId: string | null = null;
    let localCompanyName = "Unknown Company";

    if (companyId) {
      const localCompany = await prisma.companyAccount.findUnique({
        where: { id: companyId },
        select: { id: true, shopifyCompanyId: true, name: true },
      });

      if (localCompany?.shopifyCompanyId) {
        targetShopifyCompanyId = localCompany.shopifyCompanyId;
        localCompanyName = localCompany.name || localCompanyName;
      } else if (companyId.startsWith("gid://")) {
        targetShopifyCompanyId = companyId;
      }

      if (
        targetShopifyCompanyId &&
        !targetShopifyCompanyId.startsWith("gid://")
      ) {
        targetShopifyCompanyId = `gid://shopify/Company/${targetShopifyCompanyId}`;
      }
    }

    if (!targetShopifyCompanyId) {
      return {
        success: false,
        syncedCount: 0,
        message: "Company not found or missing Shopify company ID",
        errors: ["Company not found or missing Shopify company ID"],
      };
    }

    const query = `
      query GetCompanyContacts($id: ID!) {
        company(id: $id) {
          id
          name
          contacts(first: 100) {
            edges {
              node {
                id
                title
                customer {
                  id
                  email
                  firstName
                  lastName
                }
                roleAssignments(first: 10) {
                  edges {
                    node {
                      role {
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await admin.graphql(query, {
      variables: { id: targetShopifyCompanyId },
    });
    const payload = await response.json();

    if (payload.errors?.length) {
      return {
        success: false,
        syncedCount: 0,
        message: `GraphQL error: ${payload.errors[0].message}`,
        errors: payload.errors.map((e: any) => e.message),
      };
    }

    if (!payload?.data?.company) {
      return {
        success: false,
        syncedCount: 0,
        message: "Company not found in Shopify",
        errors: [`Company not found in Shopify: ${targetShopifyCompanyId}`],
      };
    }

    const contacts =
      payload.data.company.contacts?.edges?.map(
        (edge: { node: Record<string, unknown> }) => edge.node,
      ) || [];

    let syncedCount = 0;

    for (const contact of contacts) {
      const customer = contact.customer as
        | {
            id?: string;
            email?: string | null;
            firstName?: string | null;
            lastName?: string | null;
          }
        | undefined;

      if (!customer?.email) continue;

      const normalizedEmail = customer.email.trim().toLowerCase();
      const roleAssignments = (
        (
          contact.roleAssignments as
            | { edges?: Array<{ node?: { role?: { name?: string } } }> }
            | undefined
        )?.edges || []
      )
        .map((edge) => edge.node?.role?.name)
        .filter(Boolean) as string[];

      const isAdmin =
        roleAssignments.some((name) => /admin/i.test(name)) ||
        (contact.title as string | undefined)?.toLowerCase().includes("admin");
      const role = isAdmin ? UserRole.STORE_ADMIN : UserRole.STORE_USER;
      const companyRole = isAdmin ? "admin" : "member";
      const shopifyCustomerId = customer.id || null;

      await prisma.user.upsert({
        where: {
          shopId_email_role: {
            shopId: store.id,
            email: normalizedEmail,
            role,
          },
        },
        update: {
          firstName: customer.firstName || null,
          lastName: customer.lastName || null,
          shopifyCustomerId,
          companyId,
          companyRole,
          role,
          isActive: true,
          status: UserStatus.APPROVED,
        },
        create: {
          email: normalizedEmail,
          firstName: customer.firstName || null,
          lastName: customer.lastName || null,
          password: "",
          shopifyCustomerId,
          shopId: store.id,
          companyId,
          companyRole,
          role,
          status: UserStatus.APPROVED,
          isActive: true,
        },
      });

      await prisma.registrationSubmission.upsert({
        where: {
          shopId_email: {
            shopId: store.id,
            email: normalizedEmail,
          },
        },
        update: {
          email: normalizedEmail,
          companyName: localCompanyName,
          firstName: customer.firstName || "",
          lastName: customer.lastName || "",
          shopifyCustomerId,
          status: UserStatus.APPROVED,
          shopId: store.id,
        },
        create: {
          shopId: store.id,
          email: normalizedEmail,
          companyName: localCompanyName,
          firstName: customer.firstName || "",
          lastName: customer.lastName || "",
          shopifyCustomerId,
          status: UserStatus.APPROVED,
          contactTitle: (contact.title as string | undefined) || "",
          workflowCompleted: true,
        },
      });

      syncedCount += 1;
    }

    return {
      success: true,
      syncedCount,
      message:
        syncedCount > 0
          ? `Synced ${syncedCount} users successfully`
          : "No users found to sync",
      errors: [],
    };
  } catch (error) {
    console.error("Error syncing Shopify users:", error);
    return {
      success: false,
      syncedCount: 0,
      message: "Failed to sync users",
      errors: [error instanceof Error ? error.message : "Unknown sync error"],
    };
  }
};

/**
 * Sync a single Shopify B2B customer and their associated companies.
 * This is used for on-the-fly onboarding when a B2B user logs in.
 */
export const syncSingleB2BCustomer = async (
  admin: ShopifyAdminClient,
  storeId: string,
  shopifyCustomerId: string,
) => {
  try {
    // 1. Fetch customer with company profiles
    const query = `
      query GetB2BCustomer($id: ID!) {
        customer(id: $id) {
          id
          email
          firstName
          lastName
          phone
          companyContactProfiles {
            id
            title
            company {
              id
              name
              externalId
              mainContact {
                customer {
                  id
                }
              }
            }
            roleAssignments(first: 10) {
              edges {
                node {
                  role {
                    name
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await admin.graphql(query, {
      variables: {
        id: shopifyCustomerId.startsWith("gid://")
          ? shopifyCustomerId
          : `gid://shopify/Customer/${shopifyCustomerId}`,
      },
    });
    const result = await response.json();
    const customer = result?.data?.customer as ShopifyCustomerNode;

    if (!customer || !customer.email) {
      return {
        success: false,
        error: "Customer not found in Shopify or missing email",
      };
    }

    const profiles = customer.companyContactProfiles || [];
    if (profiles.length === 0) {
      return { success: false, error: "Customer has no B2B company profiles" };
    }

    let syncedCount = 0;

    for (const profile of profiles) {
      const shopifyCompany = profile.company;
      if (!shopifyCompany) continue;

      // 2. Ensure company exists in local DB
      const localCompany = await prisma.companyAccount.upsert({
        where: {
          shopId_shopifyCompanyId: {
            shopId: storeId,
            shopifyCompanyId: shopifyCompany.id,
          },
        },
        update: {
          name: shopifyCompany.name || "Unknown Company",
        },
        create: {
          shopId: storeId,
          shopifyCompanyId: shopifyCompany.id,
          name: shopifyCompany.name || "Unknown Company",
          creditLimit: new Prisma.Decimal(0), // Default to 0, sync might update it later
        },
      });

      // 3. Determine roles
      const isMainContact =
        shopifyCompany.mainContact?.customer?.id === customer.id;
      const userRole = isMainContact ? "STORE_ADMIN" : "STORE_USER";

      // 4. Upsert User
      await prisma.user.upsert({
        where: {
          shopId_email_role: {
            shopId: storeId,
            email: customer.email,
            role: userRole,
          },
        },
        update: {
          firstName: customer.firstName || "",
          lastName: customer.lastName || "",
          shopifyCustomerId: customer.id,
          companyId: localCompany.id,
          companyRole: userRole === "STORE_ADMIN" ? "admin" : "member",
          isActive: true,
          role: userRole,
          status: "APPROVED", // Auto-approved because they already have B2B in Shopify
        },
        create: {
          email: customer.email,
          firstName: customer.firstName || null,
          lastName: customer.lastName || null,
          password: "",
          role: userRole,
          status: "APPROVED",
          isActive: true,
          shopId: storeId,
          companyId: localCompany.id,
          companyRole: userRole === "STORE_ADMIN" ? "admin" : "member",
          shopifyCustomerId: customer.id,
        },
      });

      // 5. Ensure RegistrationSubmission exists for status tracking
      await prisma.registrationSubmission.upsert({
        where: {
          shopId_email: { shopId: storeId, email: customer.email },
        },
        update: {
          status: "APPROVED",
          companyName: localCompany.name,
          shopifyCustomerId: customer.id,
        },
        create: {
          shopId: storeId,
          email: customer.email,
          companyName: localCompany.name,
          firstName: customer.firstName || "",
          lastName: customer.lastName || "",
          contactTitle: profile.title || "",
          status: "APPROVED",
          shopifyCustomerId: customer.id,
          workflowCompleted: true,
        },
      });

      syncedCount++;
    }

    return { success: true, syncedCount };
  } catch (error) {
    console.error("Error in syncSingleB2BCustomer:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
};

export const syncShopifyOrders = async (
  admin: ShopifyAdminClient,
  store: StoreRef,
  companyId?: string,
) => {
  try {
    let targetShopifyCompanyId: string | null = null;
    let localCompanyId: string | null = null;

    if (companyId) {
      const localCompany = await prisma.companyAccount.findUnique({
        where: { id: companyId },
        select: { id: true, shopifyCompanyId: true },
      });
      if (!localCompany?.shopifyCompanyId) {
        return {
          success: false,
          syncedCount: 0,
          errors: ["Company not found or missing Shopify company ID"],
          message: "Company not found",
        };
      }
      targetShopifyCompanyId = localCompany.shopifyCompanyId;
      localCompanyId = localCompany.id;
    }

    if (
      targetShopifyCompanyId &&
      !targetShopifyCompanyId.startsWith("gid://")
    ) {
      targetShopifyCompanyId = `gid://shopify/Company/${targetShopifyCompanyId}`;
    }

    console.log(targetShopifyCompanyId, localCompanyId, "companyId11111");
    if (!targetShopifyCompanyId || !localCompanyId) {
      return {
        success: false,
        syncedCount: 0,
        errors: ["companyId is required for order sync"],
        message: "Missing companyId",
      };
    }

    // ── Paginate through all company orders ──────────────────────────────
    let allOrders: ShopifyOrder[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const orderQuery = `
        query CompanyOrders($companyId: ID!, $cursor: String) {
          company(id: $companyId) {
            orders(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  name
                  createdAt
                  displayFinancialStatus
                  displayFulfillmentStatus
                  totalPriceSet {
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
                  totalShippingPriceSet {
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
                  currentTotalDiscountSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          `;
      const response = await admin.graphql(orderQuery, {
        variables: { companyId: targetShopifyCompanyId, cursor },
      });
      const result = await response.json();

      if (result.errors?.length) {
        return {
          success: false,
          syncedCount: allOrders.length,
          errors: result.errors.map((e: any) => e.message),
          message: `GraphQL error: ${result.errors[0].message}`,
        };
      }

      if (!result?.data?.company) {
        return {
          success: false,
          syncedCount: allOrders.length,
          errors: [`Company not found in Shopify: ${targetShopifyCompanyId}`],
          message: "Company not found in Shopify",
        };
      }

      const data = result.data.company.orders;

      if (data?.edges?.length) {
        allOrders = [
          ...allOrders,
          ...data.edges.map((edge: { node: ShopifyOrder }) => edge.node),
        ];
      }

      hasNextPage = data?.pageInfo?.hasNextPage || false;
      cursor = data?.pageInfo?.endCursor || null;
    }

    // ── Upsert each order into b2BOrder ─────────────────────────────────
    let syncedCount = 0;
    const errors: string[] = [];

    for (const order of allOrders) {
      try {
        if (!order?.id) continue;

        const totalAmount = new Decimal(
          order.totalPriceSet?.shopMoney?.amount ?? "0",
        );

        // Resolve the local user from the order's customer email
        let createdByUserId: string | undefined;
        if (order.customer?.email) {
          const localUser = await prisma.user.findFirst({
            where: {
              shopId: store.id,
              email: order.customer.email,
            },
            select: { id: true },
          });
          createdByUserId = localUser?.id ?? undefined;
        }

        if (!createdByUserId) {
          const fallbackUser = await prisma.user.findFirst({
            where: {
              shopId: store.id,
              companyId: localCompanyId,
            },
            select: { id: true },
          });
          createdByUserId = fallbackUser?.id;
        }

        if (!createdByUserId) {
          errors.push(
            `Skipped order ${order.name ?? order.id}: no local company user found`,
          );
          continue;
        }

        const customerName =
          [order.customer?.firstName, order.customer?.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() || null;
        const customerEmail = order.customer?.email || null;
        const currencyCode =
          order.totalPriceSet?.shopMoney?.currencyCode || "USD";
        const subtotal = new Decimal(
          order.subtotalPriceSet?.shopMoney?.amount ?? "0",
        );
        const shippingAmount = new Decimal(
          order.totalShippingPriceSet?.shopMoney?.amount ?? "0",
        );
        const taxAmount = new Decimal(
          order.totalTaxSet?.shopMoney?.amount ?? "0",
        );
        const discountTotal = new Decimal(
          order.currentTotalDiscountSet?.shopMoney?.amount ?? "0",
        );
        const orderNumber = order.name || null;
        const paymentStatus = "pending";
        const orderStatus = "payment_pending";

        await prisma.b2BOrder.upsert({
          where: {
            shopifyOrderId: order.id,
          },
          update: {
            orderTotal: totalAmount,
            customerName,
            customerEmail,
            orderNumber,
            currencyCode,
            subtotal,
            shippingAmount,
            taxAmount,
            discountTotal,
            updatedAt: new Date(),
          },
          create: {
            shopifyOrderId: order.id,
            companyId: localCompanyId,
            shopId: store.id,
            createdByUserId,
            orderTotal: totalAmount,
            creditUsed: new Decimal(0),
            userCreditUsed: new Decimal(0),
            paymentStatus,
            orderStatus,
            remainingBalance: new Decimal(0),
            paidAmount: new Decimal(0),
            orderNumber,
            customerName,
            customerEmail,
            currencyCode,
            subtotal,
            shippingAmount,
            taxAmount,
            discountTotal,
            createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),
          },
        });

        syncedCount++;
      } catch (orderError) {
        console.error(`Error syncing order ${order?.name}:`, orderError);
        errors.push(
          `Failed to sync order ${order?.name ?? order?.id}: ${
            orderError instanceof Error ? orderError.message : "Unknown error"
          }`,
        );
      }
    }

    return {
      success: true,
      syncedCount,
      errors,
      message:
        errors.length > 0
          ? `Synced ${syncedCount} orders with ${errors.length} errors`
          : `Successfully synced ${syncedCount} orders`,
    };
  } catch (error) {
    console.error("Order sync error:", error);
    return {
      success: false,
      syncedCount: 0,
      errors: [error instanceof Error ? error.message : "Unknown error"],
      message: "Sync failed",
    };
  }
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  subtotalPriceSet?: {
    shopMoney: { amount: string; currencyCode: string };
  } | null;
  totalShippingPriceSet?: {
    shopMoney: { amount: string; currencyCode: string };
  } | null;
  totalTaxSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
  currentTotalDiscountSet?: {
    shopMoney: { amount: string; currencyCode: string };
  } | null;
  customer: {
    id: string;
    firstName: string;
    lastName: string | null;
    email: string;
  } | null;
}
