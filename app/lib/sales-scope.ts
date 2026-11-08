import type {WorkbenchState} from './types.ts';
export interface SalesScope {salesId:string;displayName:string;accountId?:string;}
export interface SalesOwner {salesId:string;displayName:string;}
const scopes=new WeakMap<WorkbenchState,SalesScope>();
const rosters=new WeakMap<WorkbenchState,SalesOwner[]>();
export const scopeFor=(state:WorkbenchState):SalesScope=>scopes.get(state)??{salesId:'sales-1',displayName:'林晓'};
export function bindScope(state:WorkbenchState,scope?:SalesScope,roster?:SalesOwner[]){if(scope)scopes.set(state,scope);if(roster)rosters.set(state,roster);}
export const rosterFor=(state:WorkbenchState)=>rosters.get(state);
