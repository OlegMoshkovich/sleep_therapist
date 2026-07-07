import { NextResponse } from 'next/server'
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isProtectedDemoRoute = createRouteMatcher([
  '/demo/nutrition/expert(.*)',
  '/demo/nutrition/input(.*)',
  '/demo/nutritian/input(.*)',
  '/demo/general-orchestration-daemon/input(.*)',
  '/sandbox(.*)',
])

// Routes the restricted "air" login may not reach directly. These mirror what
// SiteNavbar / the demo page hide for "air" users: the "Details" page and the
// General Orchestration Daemon (GOD) card.
const isAirBlockedRoute = createRouteMatcher([
  '/technical(.*)',
  '/demo/general-orchestration-daemon(.*)',
])

// AIR_CLERK_* are the project-specific Clerk credentials; we override the
// default CLERK_* lookup so this project can deploy alongside another
// Clerk-using project on Vercel without env-var collisions.
const secretKey =
  process.env.AIR_CLERK_SECRET_KEY ?? process.env.CLERK_SECRET_KEY
const publishableKey =
  process.env.NEXT_PUBLIC_AIR_CLERK_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

export default clerkMiddleware(
  async (auth, request) => {
    // "air" users are redirected away from routes reserved for the "us" login.
    if (
      request.cookies.get('siteAuthType')?.value === 'air' &&
      isAirBlockedRoute(request)
    ) {
      const url = request.nextUrl.clone()
      url.pathname = '/demo'
      return NextResponse.redirect(url)
    }

    if (isProtectedDemoRoute(request)) {
      await auth.protect()
    }
  },
  { secretKey, publishableKey }
)

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
