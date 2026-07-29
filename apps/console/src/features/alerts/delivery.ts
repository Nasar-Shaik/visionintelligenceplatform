import type { NotificationChannelType, NotificationStatus } from '@vip/contracts';
import type { BadgeProps } from '@/ui/badge';

/**
 * Delivery-state presentation for the alert log (contract `NotificationStatus`):
 *   pending → sent → delivered | failed, and sent/delivered → acked.
 * Defined once so the table and any future detail stay consistent.
 */
export const DELIVERY_STATUS: Record<
  NotificationStatus,
  { label: string; variant: BadgeProps['variant'] }
> = {
  pending: { label: 'Pending', variant: 'neutral' },
  sent: { label: 'Sent', variant: 'brand' },
  delivered: { label: 'Delivered', variant: 'success' },
  failed: { label: 'Failed', variant: 'critical' },
  acked: { label: 'Acked', variant: 'success' },
};

export const CHANNEL_LABEL: Record<NotificationChannelType, string> = {
  'in-app': 'In-app',
  webhook: 'Webhook',
};

/** Ack is offered only for a live delivery that a recipient hasn't yet acknowledged. */
export function canAckStatus(status: NotificationStatus): boolean {
  return status === 'sent' || status === 'delivered';
}
