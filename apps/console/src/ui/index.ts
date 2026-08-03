// Design-system barrel — primitives + SOC composites. Import from `@/ui`.

// Primitives (shadcn/ui, themed to tokens)
export { Alert } from './alert';
export { Badge, badgeVariants } from './badge';
export { Button, buttonVariants } from './button';
export type { ButtonProps } from './button';
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './card';
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './dialog';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from './dropdown-menu';
export { Input } from './input';
export { Label } from './label';
export { ScrollArea } from './scroll-area';
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSeparator,
} from './select';
export { Separator } from './separator';
export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from './sheet';
export { Skeleton } from './skeleton';
export { Switch } from './switch';
export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from './table';
export type { TableDensity } from './table';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';
export { Textarea } from './textarea';
export { Toaster, toast } from './toaster';
export { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from './tooltip';

// SOC composites
export { CameraTile } from './soc/camera-tile';
export { DetectionOverlay } from './soc/detection-overlay';
export type { DetectionBox } from './soc/detection-overlay';
export { EmptyState } from './soc/empty-state';
export { FilterBar } from './soc/filter-bar';
export { IncidentCard } from './soc/incident-card';
export type { IncidentCardStatus } from './soc/incident-card';
export { CardSkeleton, TableSkeleton, TileSkeleton } from './soc/loading-skeleton';
export { MetricCard } from './soc/metric-card';
export { NotificationCard } from './soc/notification-card';
export type { DeliveryStatus, NotificationChannelKind } from './soc/notification-card';
export { PageHeader } from './soc/page-header';
export { PageSkeleton } from './soc/page-skeleton';
export type { Breadcrumb } from './soc/page-header';
export { QueryBoundary, UnavailableState } from './soc/query-boundary';
export { SeverityBadge, SEVERITY_BORDER } from './soc/severity-badge';
export { StatusIndicator } from './soc/status-indicator';
export { Timeline } from './soc/timeline';
export type { TimelineItem } from './soc/timeline';
export { VideoPlayerContainer } from './soc/video-player-container';
