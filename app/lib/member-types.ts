/** App-level identity inside the owner-private Sites workspace. */
export type MemberRole='sales'|'manager'|'admin';
export interface MemberSession {
  username:string;
  displayName:string;
  role:MemberRole;
  accountId:string;
  salesId?:string;
}
export interface WorkspaceMember extends MemberSession {enabled:boolean;}
