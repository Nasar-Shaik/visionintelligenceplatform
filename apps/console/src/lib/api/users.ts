import type { CreateUserInput, UpdateUserInput, User } from '@vip/contracts';
import { http } from './http';

/** What a disable or a password reset reports back: the row, plus how many sessions it ended. */
export interface UserMutationResult {
  user: User;
  sessionsRevoked: number;
}

/**
 * User administration (through the gateway: `/api/identity/users/*`).
 *
 * Note the shape of this surface: one `PATCH` for roles, and three named `POST`s for the acts that
 * have consequences. `disable` and `password` each end the target's open sessions, and they return
 * the count so the console can say so rather than leave the administrator guessing whether the
 * person they just offboarded is still logged in.
 *
 * There is deliberately no `remove`. A user is disabled, never deleted — incidents name their
 * assignee and the audit names who looked, and deleting the row would turn that history into a
 * dangling id.
 */
export const usersApi = {
  list: () => http.get<User[]>('/identity/users'),

  get: (userId: string) => http.get<User>(`/identity/users/${userId}`),

  create: (input: CreateUserInput) => http.post<User>('/identity/users', input),

  /** Roles only. Email is immutable and status is changed by `disable`/`enable`. */
  update: (userId: string, patch: UpdateUserInput) =>
    http.patch<User>(`/identity/users/${userId}`, patch),

  disable: (userId: string) =>
    http.post<UserMutationResult>(`/identity/users/${userId}/disable`, {}),

  enable: (userId: string) => http.post<User>(`/identity/users/${userId}/enable`, {}),

  setPassword: (userId: string, password: string) =>
    http.post<UserMutationResult>(`/identity/users/${userId}/password`, { password }),
};
