import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import PasswordProtection from "./components/PasswordProtection";
import PostSignInRedirect from "./components/PostSignInRedirect";
import { ThemeProvider } from "./context/ThemeContext";
import NavigationOverlay from "./components/NavigationOverlay";
import { resolveCurrentUser } from "./lib/admin-auth";

// Logo lettering font (the THE AIR LAB grid).
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["300", "400"],
  variable: "--font-archivo",
  display: "swap",
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  title: "The AI Research Lab",
  description: "The AI Research Lab",
  metadataBase: new URL(siteUrl),
  // Stop iOS Safari from auto-linking (and underlining) emails/phone numbers
  // shown as plain text, e.g. the account email next to the ADMIN pill.
  formatDetection: { email: false, telephone: false, address: false },
  openGraph: {
    title: "The AI Research Lab",
    description: "Solving fundamental problems, uncertainty and hallucinations \nin AI systems.",
    images: [
      {
        url: "/logos/Preview.png",
        width: 1200,
        height: 630,
        alt: "The AI Research Lab",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "The AI Research Lab",
    description: "Solving fundamental problems, uncertainty and hallucinations \nin AI systems.",
    images: ["/logos/Preview.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Ensure every signed-in Clerk user has a user_roles row.
  await resolveCurrentUser().catch(() => null);

  const publishableKey =
    process.env.NEXT_PUBLIC_AIR_CLERK_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  return (
    <ClerkProvider publishableKey={publishableKey}>
      <html lang="en">
        <body className={`${archivo.variable} antialiased font-sans`}>
          <ThemeProvider>
            <NavigationOverlay />
            <PostSignInRedirect />
            <PasswordProtection>
              {children}
            </PasswordProtection>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
