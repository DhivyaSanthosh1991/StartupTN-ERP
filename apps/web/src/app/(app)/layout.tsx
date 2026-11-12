'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon, IconName } from '@/components/icons';
import { LocationSharing } from '@/components/location-sharing';
import { PresenceWatcher } from '@/components/presence-check';
import { Avatar, Loading, cx } from '@/components/ui';
import { api } from '@/lib/api';
import { LOGO_SIZE, LOGO_SRC } from '@/lib/logo';
import { Role, useSession } from '@/lib/session';

interface NavItem { href: string; label: string; icon: IconName; roles?: Role[] }

const NAV: NavItem[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/attendance', label: 'Attendance', icon: 'clock' },
  { href: '/leave', label: 'Leave', icon: 'sun' },
  { href: '/duty', label: 'On duty', icon: 'briefcase' },
  { href: '/approvals', label: 'Approvals', icon: 'check' },
  { href: '/people', label: 'People', icon: 'people' },
  { href: '/calendar', label: 'Holidays and notices', icon: 'calendar' },
];

const ADMIN: NavItem[] = [
  { href: '/admin/employees', label: 'Employees', icon: 'people', roles: ['hr_admin', 'super_admin'] },
  { href: '/admin/leave', label: 'Leave rules', icon: 'sun', roles: ['hr_admin'] },
  { href: '/admin/approvals', label: 'Approval flows', icon: 'check', roles: ['hr_admin'] },
  { href: '/admin/attendance', label: 'Attendance setup', icon: 'pin', roles: ['hr_admin'] },
  { href: '/admin/organisation', label: 'Departments', icon: 'briefcase', roles: ['hr_admin'] },
  { href: '/admin/settings', label: 'Working hours', icon: 'clock', roles: ['hr_admin'] },
  { href: '/admin/documents', label: 'Documents due', icon: 'file', roles: ['hr_admin'] },
  { href: '/admin/audit', label: 'Audit log', icon: 'shield', roles: ['hr_admin', 'super_admin'] },
];

const TABS = ['/', '/attendance', '/leave', '/approvals'];

const isActive = (path: string, href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, loading, logout, has } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    if (!loading && !me) router.replace('/login');
  }, [loading, me, router]);

  useEffect(() => setMenu(false), [path]);

  // The approvals badge: how many requests are waiting on this person.
  useEffect(() => {
    if (!me) return;
    let live = true;
    const load = () => api<unknown[]>('/approvals/inbox').then((r) => live && setWaiting(r.length)).catch(() => undefined);
    void load();
    const timer = setInterval(load, 60_000);
    window.addEventListener('erp:approvals-changed', load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('erp:approvals-changed', load);
    };
  }, [me, path]);

  if (loading || !me) {
    return <div className="grid min-h-dvh place-items-center"><Loading label="Opening your portal" /></div>;
  }

  const admin = ADMIN.filter((i) => has(...(i.roles ?? [])));
  const link = (i: NavItem) => {
    const active = isActive(path, i.href);
    return (
      <Link key={i.href} href={i.href} aria-current={active ? 'page' : undefined}
        className={cx('relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
          active ? 'bg-peacock-tint font-semibold text-peacock-dark' : 'text-ink/80 hover:bg-wash')}>
        <Icon name={i.icon} className="size-5 shrink-0" />
        <span className="flex-1">{i.label}</span>
        {i.href === '/approvals' && waiting > 0 && (
          <span className="rounded-full bg-marigold px-2 text-xs font-semibold text-ink" aria-label={`${waiting} waiting`}>{waiting}</span>
        )}
      </Link>
    );
  };

  const navigation = (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(link)}
      {admin.length > 0 && (
        <>
          <p className="mb-1 mt-5 px-3 text-xs font-semibold text-muted">HR and admin</p>
          {admin.map(link)}
        </>
      )}
    </nav>
  );

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[250px_1fr]">
      <aside className="hidden border-r border-line bg-surface md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        <div className="px-5 pb-4 pt-6">
          <Link href="/" aria-label="StartupTN home" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_SRC} alt="StartupTN" width={LOGO_SIZE.width} height={LOGO_SIZE.height} className="h-auto w-44" />
          </Link>
          <p className="mt-1 text-xs text-muted">Staff portal</p>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">{navigation}</div>
        <div className="flex items-center gap-3 border-t border-line p-4">
          <Avatar name={me.fullName} />
          <div className="min-w-0 flex-1">
            <Link href={`/people/${me.id}`} className="block truncate text-sm font-medium hover:underline">{me.fullName}</Link>
            <p className="truncate text-xs text-muted">{me.designation ?? me.empCode}</p>
          </div>
          <button type="button" onClick={async () => { await logout(); router.replace('/login'); }} aria-label="Sign out" title="Sign out"
            className="rounded-lg p-2 text-muted hover:bg-wash hover:text-ink">
            <Icon name="logout" />
          </button>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-3 backdrop-blur md:hidden">
          <Link href="/" aria-label="StartupTN home" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_SRC} alt="StartupTN" width={LOGO_SIZE.width} height={LOGO_SIZE.height} className="h-8 w-auto" />
          </Link>
          <button type="button" onClick={() => setMenu(true)} aria-label="Open menu" className="-mr-2 rounded-lg p-2 hover:bg-wash"><Icon name="menu" /></button>
        </header>

        {menu && (
          <div className="fixed inset-0 z-50 flex flex-col bg-surface md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="flex items-center gap-3"><Avatar name={me.fullName} /><div><p className="text-sm font-medium">{me.fullName}</p><p className="text-xs text-muted">{me.designation ?? me.empCode}</p></div></div>
              <button type="button" onClick={() => setMenu(false)} aria-label="Close menu" className="rounded-lg p-2 hover:bg-wash"><Icon name="close" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {navigation}
              <Link href={`/people/${me.id}`} className="mt-3 flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-wash"><Icon name="file" className="size-5" />My profile and documents</Link>
              <button type="button" onClick={async () => { await logout(); router.replace('/login'); }} className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-wash"><Icon name="logout" className="size-5" />Sign out</button>
            </div>
          </div>
        )}

        <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:px-8 md:pb-14 md:pt-9">{children}</main>
        <PresenceWatcher />
        <LocationSharing />

        <nav aria-label="Quick links" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-line bg-surface md:hidden">
          {NAV.filter((i) => TABS.includes(i.href)).map((i) => {
            const active = isActive(path, i.href);
            return (
              <Link key={i.href} href={i.href} aria-current={active ? 'page' : undefined}
                className={cx('relative flex flex-col items-center gap-0.5 py-2 text-xs', active ? 'font-semibold text-peacock-dark' : 'text-muted')}>
                <Icon name={i.icon} />
                {i.label}
                {i.href === '/approvals' && waiting > 0 && <span className="absolute right-[22%] top-1 size-2.5 rounded-full bg-marigold" aria-label={`${waiting} waiting`} />}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
