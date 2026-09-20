import { guestPhotosAllowed } from '$lib/server/auth';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({
	session: locals.session,
	guestPhotos: guestPhotosAllowed()
});
