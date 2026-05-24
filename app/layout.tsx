import "./globals.css";
import type { Metadata } from "next";
import ThemeToggle from "@/components/ui/ThemeToggle";

export const metadata: Metadata = {
  title: "Flex Weekly Audit",
  description:
    "Weekly job completion and invoicing audit for Flex Landscaping",
};

const themeInitScript = `
(function() {
  try {
    var stored = localStorage.getItem('theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored || (prefersDark ? 'dark' : 'light');
    if (theme === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-page-bg font-sans antialiased">
        <Header />
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
      </body>
    </html>
  );
}

function Header() {
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2v6" />
              <path d="M12 22v-6" />
              <path d="M4.93 4.93l4.24 4.24" />
              <path d="M14.83 14.83l4.24 4.24" />
              <path d="M2 12h6" />
              <path d="M22 12h-6" />
              <path d="M4.93 19.07l4.24-4.24" />
              <path d="M14.83 9.17l4.24-4.24" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight">
              Flex Weekly Audit
            </h1>
            <p className="text-xs text-muted-foreground">
              Job completion &amp; invoicing reconciliation
            </p>
          </div>
        </div>
        <nav className="flex items-center gap-1 text-sm">
          <a
            href="/"
            className="rounded-md px-3 py-1.5 font-medium hover:bg-muted"
          >
            Dashboard
          </a>
          <a
            href="/settings"
            className="rounded-md px-3 py-1.5 font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Settings
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
