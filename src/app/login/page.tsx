import { redirect } from 'next/navigation';
import { getActor } from '@/lib/auth/dal';
import { homePath } from '@/lib/dashboard/home';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  const actor = await getActor();
  if (actor) redirect(homePath(actor.role));

  return (
    <main className="flex min-h-svh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight">Aktivacity Portal</h1>
          <p className="mt-1 text-sm text-muted">Sign in to continue</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
