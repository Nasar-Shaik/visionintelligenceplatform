import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="tabular text-3xl font-semibold text-muted-foreground">404</p>
      <p className="text-sm text-muted-foreground">This screen doesn’t exist yet.</p>
      <Link to="/" className="text-sm text-brand underline-offset-4 hover:underline">
        Back to console
      </Link>
    </main>
  );
}
