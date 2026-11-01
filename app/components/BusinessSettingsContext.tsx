'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_DEADLINE_RULES, type DeadlineRules } from '../lib/project-deadline';

const BusinessSettingsContext = createContext<{rules: DeadlineRules; refreshRules: () => Promise<void>}>({rules: DEFAULT_DEADLINE_RULES, refreshRules: async () => {}});
export function BusinessSettingsProvider({children}: {children: ReactNode}) {
  const [rules,setRules]=useState<DeadlineRules>(DEFAULT_DEADLINE_RULES);
  const requestRef=useRef<AbortController|null>(null);
  const mounted=useRef(false);
  const refreshRules=useCallback(async()=>{
    requestRef.current?.abort();const request=new AbortController();requestRef.current=request;
    try {const response=await fetch('/api/business-settings',{cache:'no-store',credentials:'same-origin',signal:request.signal});if(!response.ok)return;const value=await response.json() as DeadlineRules;if(mounted.current && !request.signal.aborted && Number.isInteger(value.urgentDays)&&Number.isInteger(value.warningDays)&&value.urgentDays>0&&value.urgentDays<value.warningDays&&value.warningDays<=30)setRules({urgentDays:value.urgentDays,warningDays:value.warningDays});}catch {/* Retain last valid thresholds when the network is unavailable. */}
  },[]);
  useEffect(()=>{mounted.current=true;void Promise.resolve().then(refreshRules);const timer=setInterval(()=>void refreshRules(),30000);const focus=()=>{void refreshRules();};window.addEventListener('focus',focus);return()=>{mounted.current=false;clearInterval(timer);requestRef.current?.abort();window.removeEventListener('focus',focus);};},[refreshRules]);
  return <BusinessSettingsContext.Provider value={{rules,refreshRules}}>{children}</BusinessSettingsContext.Provider>;
}
export const useBusinessSettings=()=>useContext(BusinessSettingsContext);
