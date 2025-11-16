export let FILTER_PROFANITY = false;
export let FILTER_ADVERTISING = false;
export let USE_NEURAL_NETWORK = true;
export let CURRENT_MODEL = 'hf.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:Q4_K_M';
export let DELETE_MESSAGES = false;

export function toggleProfanity(): boolean {
	FILTER_PROFANITY = !FILTER_PROFANITY;
	return FILTER_PROFANITY;
}

export function toggleAdvertising(): boolean {
	FILTER_ADVERTISING = !FILTER_ADVERTISING;
	return FILTER_ADVERTISING;
}

export function toggleNeuralNetwork(): boolean {
	USE_NEURAL_NETWORK = !USE_NEURAL_NETWORK;
	return USE_NEURAL_NETWORK;
}

export function toggleDeleteMessages(): boolean {
	DELETE_MESSAGES = !DELETE_MESSAGES;
	return DELETE_MESSAGES;
}

export function setProfanity(state: boolean): void {
	FILTER_PROFANITY = state;
}

export function setAdvertising(state: boolean): void {
	FILTER_ADVERTISING = state;
}

export function setNeuralNetwork(state: boolean): void {
	USE_NEURAL_NETWORK = state;
}

export function setCurrentModel(model: string): void {
	CURRENT_MODEL = model;
}

export function setDeleteMessages(state: boolean): void {
	DELETE_MESSAGES = state;
}

export function getCurrentModel(): string {
	return CURRENT_MODEL;
}
