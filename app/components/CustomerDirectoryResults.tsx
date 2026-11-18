'use client';

import { memo, useMemo, useState } from 'react';
import { Building2, Search } from 'lucide-react';
import type { CustomerCompany, CustomerDirectoryScope } from '../lib/customer-workspace';
import { publicSourceLabel } from '../lib/sales-project-eligibility';

interface RowProps {
  company: CustomerCompany;
  selected: boolean;
  preferredProjectId: string | null;
  hasDraft: boolean;
  locked: boolean;
  onSelect: (company: CustomerCompany, preferredProjectId: string | null) => void;
}

const avatarTone = (name: string) => {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash % 6;
};

const CompanyRow = memo(function CompanyRow({ company, selected, preferredProjectId, hasDraft, locked, onSelect }: RowProps) {
  const firstProject = company.projects[0];
  const label = company.projects.length > 1 ? `${company.projects.length} 个项目`
    : firstProject.dataOrigin === 'research' ? publicSourceLabel(firstProject)
      : firstProject.contact || firstProject.industry || '待补充联系人';
  const stage = firstProject?.stage;
  return <button className={`cw-company${selected ? ' selected' : ''}`} aria-current={selected ? 'true' : undefined} disabled={locked} onClick={() => onSelect(company, preferredProjectId)}>
    <span className="cw-company-avatar" data-avatar-tone={avatarTone(company.name)} aria-hidden="true">{company.name.slice(0, 1)}</span>
    <span className="cw-company-copy"><strong>{company.name}</strong><span>{label}</span></span>
    {hasDraft ? <span className="cw-draft-dot" title="有未保存草稿" aria-label="有未保存草稿" /> : stage ? <span className="cw-company-stage" aria-hidden="true">{stage}</span> : null}
  </button>;
});

interface Props {
  searchId: string;
  companies: readonly CustomerCompany[];
  scope: CustomerDirectoryScope;
  selectedKey?: string;
  selectedProjectId: string | null;
  draftProjectIds: ReadonlySet<string>;
  locked: boolean;
  onSelect: (company: CustomerCompany, preferredProjectId: string | null) => void;
  onCreate: () => void;
}

const searchableText = (company: CustomerCompany) => [
  company.name,
  ...company.projects.map(project => `${project.projectName || ''} ${project.contact} ${project.owner}`),
].join(' ').toLocaleLowerCase('zh-CN');

export const CustomerDirectoryResults = memo(function CustomerDirectoryResults({ searchId, companies, scope, selectedKey, selectedProjectId, draftProjectIds, locked, onSelect, onCreate }: Props) {
  const [search, setSearch] = useState('');
  const searchIndex = useMemo(() => companies.map(company => ({ company, text: searchableText(company) })), [companies]);
  const query = search.trim().toLocaleLowerCase('zh-CN');
  const visible = useMemo(() => query ? searchIndex.filter(row => row.text.includes(query)).map(row => row.company) : companies,
    [companies, query, searchIndex]);
  return <>
    <div className="cw-directory-search">
      <label htmlFor={searchId}><Search size={15} /><span className="sr-only">搜索企业、项目或联系人</span></label>
      <input id={searchId} placeholder="搜索企业、项目或联系人" value={search} onChange={event => setSearch(event.target.value)} />
    </div>
    <nav className="cw-company-list" aria-label="可访问企业">
      {visible.map(company => {
        const selected = selectedKey === company.key;
        return <CompanyRow key={company.key} company={company} selected={selected} preferredProjectId={selected ? selectedProjectId : null}
          hasDraft={company.projects.some(project => draftProjectIds.has(project.id))} locked={locked} onSelect={onSelect} />;
      })}
    </nav>
    {!visible.length && <div className="cw-directory-empty">
      <Building2 size={24} /><p>{search ? '没有匹配的企业或项目' : scope === 'archived' ? '暂无归档企业' : '暂无当前企业'}</p>
      {!search && <button className="button secondary" disabled={locked} onClick={onCreate}>新建企业</button>}
    </div>}
  </>;
});
