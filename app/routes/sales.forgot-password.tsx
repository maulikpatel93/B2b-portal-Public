import { ActionFunctionArgs, LoaderFunctionArgs, redirect } from "react-router";
import { Form, Link, useActionData, useNavigation, useLoaderData } from "react-router";
import prisma from "app/db.server";
import { sendSalesUserPasswordResetEmail } from "app/utils/email";
import { randomUUID } from "node:crypto";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const success = url.searchParams.get("success");
  const error = url.searchParams.get("error");

  return Response.json({ success, error });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Invalid request method." });
  }

  const formData = await request.formData();
  const email = (formData.get("email") as string | null)?.trim().toLowerCase();

  if (!email) {
    return Response.json({ error: "Please enter your email address." });
  }

  const user = await prisma.user.findFirst({
    where: {
      email,
      role: "SALES_USER",
      status: "APPROVED",
      isActive: true,
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      shopId: true,
    },
  });

  if (!user?.shopId) {
    return Response.json({ success: "If an account exists for that email, we’ll send reset instructions shortly." });
  }

  const resetToken = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  const requestUrl = new URL(request.url);
  const appUrl = (process.env.SHOPIFY_APP_URL || requestUrl.origin || "https://example.com").replace(/\/$/, "");
  const resetLink = `${appUrl}/sales/reset-password?token=${resetToken}&email=${encodeURIComponent(user.email)}`;

  try {
    const emailResult = await sendSalesUserPasswordResetEmail({
      storeId: user.shopId,
      email: user.email,
      firstName: user.firstName || "there",
      resetLink,
    });

    if (!emailResult.success) {
      console.error("Sales forgot-password email failed", emailResult.error);
      return Response.json({ error: "We could not send the password reset email right now. Please try again in a few minutes." });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: resetToken,
        passwordResetExpiresAt: expiresAt,
      },
    });
  } catch (error) {
    console.error("Sales forgot-password email error", error);
    return Response.json({ error: "We could not send the password reset email right now. Please try again in a few minutes." });
  }

  return Response.json({ success: "If an account exists for that email, we’ll send reset instructions shortly." });
};

export default function SalesForgotPassword() {
  const loaderData = useLoaderData<{ success?: string | null; error?: string | null }>();
  const actionData = useActionData<{ success?: string; error?: string }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const message = actionData?.success || actionData?.error || loaderData?.success || loaderData?.error;

  return (
    <div style={styles.pageContainer}>
      <div style={styles.card}>
        <div style={styles.header}>
          <h1 style={styles.heroText}>Forgot password?</h1>
          <p style={styles.bodyText}>
            Enter the email connected to your Sales Portal account and we’ll send a reset link.
          </p>
        </div>

        {message && (
          <div style={message.includes("success") || message.includes("we’ll") ? styles.successAlert : styles.errorAlert}>
            {message}
          </div>
        )}

        <Form method="post" style={styles.form}>
          <div style={styles.inputGroup}>
            <label htmlFor="sales-reset-email" style={styles.label}>
              Email Address
            </label>
            <input
              id="sales-reset-email"
              type="email"
              name="email"
              required
              autoComplete="email"
              style={styles.input}
              placeholder="you@company.com"
            />
          </div>

          <button type="submit" style={styles.button} disabled={isSubmitting}>
            {isSubmitting ? "Sending..." : "Send reset link"}
          </button>
        </Form>

        <div style={styles.footerActions}>
          <Link to="/sales/login" style={styles.linkText}>
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

const styles = {
  pageContainer: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #fdf4f7 0%, #fff7eb 100%)",
    padding: "20px",
    fontFamily: "'Inter', sans-serif",
  },
  card: {
    width: "100%",
    maxWidth: "430px",
    background: "rgba(255,255,255,0.95)",
    borderRadius: "24px",
    padding: "40px",
    boxShadow: "0 20px 40px rgba(0,0,0,0.08)",
  },
  header: {
    marginBottom: "24px",
  },
  heroText: {
    fontSize: "28px",
    fontWeight: 700,
    margin: "0 0 8px",
    color: "#111827",
  },
  bodyText: {
    margin: 0,
    color: "#6b7280",
    lineHeight: 1.6,
  },
  form: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "18px",
  },
  inputGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
  },
  label: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#374151",
  },
  input: {
    padding: "14px 16px",
    borderRadius: "12px",
    border: "1px solid #e5e7eb",
    fontSize: "15px",
    outline: "none",
  },
  button: {
    padding: "14px 20px",
    borderRadius: "14px",
    border: "none",
    background: "linear-gradient(135deg, var(--sales-portal-accent) 0%, var(--sales-portal-accent-dark) 100%)",
    color: "var(--sales-portal-accent-contrast)",
    fontSize: "15px",
    fontWeight: 600,
    cursor: "pointer",
  },
  successAlert: {
    background: "#ecfdf3",
    color: "#166534",
    border: "1px solid #a7f3d0",
    borderRadius: "12px",
    padding: "12px 14px",
    marginBottom: "16px",
    fontSize: "14px",
  },
  errorAlert: {
    background: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
    borderRadius: "12px",
    padding: "12px 14px",
    marginBottom: "16px",
    fontSize: "14px",
  },
  footerActions: {
    marginTop: "20px",
    display: "flex",
    justifyContent: "center",
  },
  linkText: {
    color: "#E91E63",
    textDecoration: "none",
    fontWeight: 600,
  },
};
