export let profanityWords = new Set<string>();
export let adWords = new Set<string>();
export let customWords = new Set<string>();

export function updateProfanity(words: string[]) {
	profanityWords = new Set(words);
}
export function updateAd(words: string[]) {
	adWords = new Set(words);
}
export function updateCustom(words: string[]) {
	customWords = new Set(words);
}

export function checkProfanity(text: string): boolean {
	return [...profanityWords].some(word => text.includes(word));
}
export function checkAd(text: string): boolean {
	return [...adWords].some(word => text.includes(word));
}
export function checkCustom(text: string): boolean {
	return [...customWords].some(word => text.includes(word));
}
