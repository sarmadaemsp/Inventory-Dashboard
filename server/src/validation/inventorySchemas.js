import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

export const inventoryQuerySchema = z.object({
  page:          positiveInt.optional().default(1),
  pageSize:      positiveInt.max(10000).optional().default(50),
  search:        z.string().optional(),
  sort_by:       z.enum(['sku', 'upc', 'box_number', 'quantity', 'date_added', 'part_number', 'notes', 'remaining_stock']).optional().default('date_added'),
  sort_dir:      z.enum(['asc', 'desc']).optional().default('desc'),
  status:        z.enum(['all', 'in_stock', 'oos', 'undefined']).optional().default('all'),
});
