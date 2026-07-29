import { RouterProvider } from 'react-router-dom';
import { Providers } from '@/app/providers';
import { router } from '@/app/router';
import { AuthBootstrap } from '@/features/auth/AuthBootstrap';
import { Toaster, TooltipProvider } from '@/ui';

export function App() {
  return (
    <Providers>
      <AuthBootstrap>
        <TooltipProvider delayDuration={200}>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </AuthBootstrap>
    </Providers>
  );
}
