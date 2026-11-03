'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icons';
import { Avatar, Empty, ErrorNote, Input, Loading, PageHeader, Panel } from '@/components/ui';
import { useApi } from '@/lib/api';
import type { DirectoryPerson } from '@/lib/types';

export default function PeoplePage() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const { data, error, loading, reload } = useApi<DirectoryPerson[]>(`/employees/directory${query ? `?search=${encodeURIComponent(query)}` : ''}`);

  return (
    <div>
      <PageHeader title="People" description="Everyone at StartupTN. Open a profile to see more." />
      <div className="relative mb-5 max-w-md">
        <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, role or employee code" className="pl-9" aria-label="Search people" />
      </div>
      {loading && !data && <Loading />}
      {error && <ErrorNote error={error} retry={reload} />}
      {data?.length === 0 && <Empty title="No one found">Try a different name or employee code.</Empty>}
      {data && data.length > 0 && (
        <Panel>
          <ul className="divide-y divide-line">
            {data.map((p) => (
              <li key={p.id}>
                <Link href={`/people/${p.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-wash/60">
                  <Avatar name={p.fullName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.fullName}</span>
                    <span className="block truncate text-sm text-muted">{p.designation ?? 'Staff'}{p.departmentName && !p.designation?.includes(p.departmentName) ? ` · ${p.departmentName}` : ''}</span>
                  </span>
                  <span className="hidden text-sm text-muted sm:block">{p.empCode}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
