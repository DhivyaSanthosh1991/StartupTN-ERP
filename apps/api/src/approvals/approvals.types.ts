import { Queryable } from '../db/db.service';

export type RequestType = 'leave' | 'od' | 'permission' | 'regularisation' | 'od_home';
export const REQUEST_TYPES: RequestType[] = ['leave', 'od', 'permission', 'regularisation', 'od_home'];

export interface ApprovalRequestRow {
  id: string;
  requestType: RequestType;
  refId: string;
  requesterId: string;
  size: number;
  summary: string;
}

/**
 * Each request type (leave, OD, ...) plugs in here. The engine calls these inside the same
 * database transaction as the final decision, so the business record and the approval never disagree.
 */
export interface ApprovalHandler {
  onApproved(q: Queryable, request: ApprovalRequestRow): Promise<void>;
  onRejected(q: Queryable, request: ApprovalRequestRow, reason: string): Promise<void>;
}

export interface SubmitInput {
  type: RequestType;
  refId: string;
  requesterId: string;
  summary: string;
  /** Used by steps with a "min days" condition (leave days; 1 for everything else). */
  size?: number;
}
