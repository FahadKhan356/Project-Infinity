import { requireActorAllowingPasswordChange } from '@/lib/auth/dal';
import { ChangePasswordForm } from './change-password-form';

export default async function ChangePasswordPage() {
  const actor = await requireActorAllowingPasswordChange();

  return (
    <main className="flex min-h-svh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight">
            {actor.mustChangePassword ? 'Set your password' : 'Change your password'}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {actor.mustChangePassword
              ? 'Your account was created with a temporary password. Choose a new one to continue.'
              : `Signed in as ${actor.email}`}
          </p>
        </div>
        <ChangePasswordForm />
      </div>
    </main>
  );
}
