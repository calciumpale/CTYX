'use client';

import { useId, type MouseEvent } from 'react';
import type { View, ViewProps } from '../lib/types';
import { workspaceSearch } from '../lib/workspace-navigation';
import { ContractReviewView } from './ContractReviewView';
import { ApprovalWorkspace } from './ApprovalWorkspace';
import './contract-center.css';

type ContractTab = 'contracts' | 'approvals';
type Props = ViewProps & {
  initialTab?: ContractTab;
  initialDealId?: string | null;
  initialContractId?: string | null;
  initialApprovalId?: string | null;
  onNavigate: (view: View, id?: string, contractId?: string, approvalId?: string) => void;
  onReloadWorkspace?: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  pendingCount?: number;
};

export function ContractCenter({ initialTab = 'contracts', initialDealId, initialContractId, initialApprovalId, onNavigate, onReloadWorkspace, onBusyChange, onDirtyChange, pendingCount = 0, ...props }: Props) {
  const prefix = useId();
  const route = (tab: ContractTab) => ({
    view: tab, dealId: initialDealId || undefined, contractId: initialContractId || undefined,
    approvalId: tab === 'approvals' ? initialApprovalId || undefined : undefined,
  });
  const navigateTab = (event: MouseEvent<HTMLAnchorElement>, tab: ContractTab) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (tab === initialTab) return;
    const next = route(tab);
    onNavigate(next.view, next.dealId, next.contractId, next.approvalId);
  };

  return <section className="contract-center" aria-labelledby={`${prefix}-title`}>
    <header className="contract-center-heading"><h1 id={`${prefix}-title`}>合同及审批</h1></header>
    <nav className="contract-center-tabs" aria-label="合同及审批分类">
      {([{ id: 'contracts', label: '合同初审' }, { id: 'approvals', label: '审批' }] as const).map(tab => <a key={tab.id} href={`/${workspaceSearch('', route(tab.id))}`} aria-current={tab.id === initialTab ? 'page' : undefined} onClick={event => navigateTab(event, tab.id)}>{tab.label}{tab.id === 'approvals' && pendingCount > 0 && <span aria-label={`${pendingCount} 项待审批`}>{pendingCount}</span>}</a>)}
    </nav>
    {initialTab === 'contracts' ? <ContractReviewView key={`contracts:${initialDealId || ''}:${initialContractId || ''}`} {...props} embeddedHeading initialDealId={initialDealId} initialContractId={initialContractId} onNavigate={onNavigate} onBusyChange={onBusyChange} onDirtyChange={onDirtyChange} onApproval={(contractId, dealId) => onNavigate('approvals', dealId, contractId)} /> : <ApprovalWorkspace key={`approvals:${initialDealId || ''}:${initialContractId || ''}:${initialApprovalId || ''}`} embeddedHeading state={props.state} notify={props.notify} onNavigate={onNavigate} initialDealId={initialDealId} initialContractId={initialContractId} initialApprovalId={initialApprovalId} onReloadWorkspace={onReloadWorkspace} onBusyChange={onBusyChange} onDirtyChange={onDirtyChange} />}
  </section>;
}
