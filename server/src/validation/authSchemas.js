import { z } from 'zod';

export const loginBodySchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1),
  // "Remember this device" — when true, the issued refresh token uses
  // JWT_REFRESH_EXPIRES_REMEMBERED (30d default) instead of the short
  // session default (7d). Frontend persists the refresh token in
  // localStorage so it survives browser restart. Default: false.
  remember: z.boolean().optional().default(false),
});

export const selectOrgBodySchema = z.object({
  membership_id: z.string().uuid(),
  // Echoed from the login form's checkbox; the pending_token also
  // carries it, but accepting it here lets the user flip the toggle
  // on the org-selector screen if we expose it there.
  remember: z.boolean().optional(),
});

export const refreshBodySchema = z.object({
  refresh_token: z.string().min(1),
  membership_id: z.string().uuid().optional(),
});

export const logoutBodySchema = z.object({
  refresh_token: z.string().min(1).optional(),
});
