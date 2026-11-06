import { z } from 'zod';

export const key = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).describe('Jira key, e.g. PROJ-123');
