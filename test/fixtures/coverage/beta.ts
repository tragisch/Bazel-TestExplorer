export function beta(flag: boolean): string {
	const base = flag ? 'yes' : 'no';
	return `${base}-beta`;
}
