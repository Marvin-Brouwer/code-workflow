/**
 * The later of two moments, either of which may be missing, compared as moments: a code host may write
 * them with a different offset or precision each time.
 */
export function later(one: string | undefined, other: string | undefined): string | undefined {
	if (one === undefined) return other
	if (other === undefined) return one
	return new Date(one).getTime() >= new Date(other).getTime() ? one : other
}
