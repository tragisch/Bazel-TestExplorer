export const add = (a: number, b: number): number => {
	const sum = a + b;
	if (sum > 10) {
		return sum * 2;
	}
	return sum;
};

export const subtract = (a: number, b: number): number => {
	return a - b;
};
