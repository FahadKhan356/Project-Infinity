import { redirect } from 'next/navigation';
import { getActor } from '@/lib/auth/dal';
import { homePath } from '@/lib/dashboard/home';

/** "/" opens each role's own first page (brief §8, §21). */
export default async function Home() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  redirect(actor.mustChangePassword ? '/change-password' : homePath(actor.role));
}
