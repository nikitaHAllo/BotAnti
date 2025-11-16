import { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import {
	FILTER_PROFANITY,
	FILTER_ADVERTISING,
	USE_NEURAL_NETWORK,
} from '../state.js';
import { checkProfanity, checkAd, checkCustom } from '../filters.js';
import { analyzeSequentially } from '../neural.js';
import { getViolationReason } from './violationHandler.js';
import { MessageData } from './documentHandler.js';

export interface ActiveAnalysis {
	cancel: boolean;
	controller: AbortController;
}

export interface PendingMessages {
	messages: MessageData[];
	fileName: string;
}

export const activeAnalyses = new Map<number, ActiveAnalysis>();
export const pendingMessages = new Map<number, PendingMessages>();

const UPDATE_INTERVAL = 1000;
const PROGRESS_UPDATE_FREQUENCY = 5;
const NEURAL_LOG_FREQUENCY = 100;
const MAX_MESSAGE_LENGTH = 4000;
const WARNING_DELETE_TIMEOUT = 10000;

function escapeMarkdownV2(str = ''): string {
	return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function createCancelKeyboard(chatId: number): InlineKeyboard {
	return new InlineKeyboard().text('🛑 Отменить анализ', `cancel_${chatId}`);
}

async function updateProgress(
	ctx: Context,
	chatId: number,
	progressMessageId: number,
	current: number,
	total: number,
	startTime: number,
	lastUpdateTime: { value: number },
	cancelKeyboard: InlineKeyboard
) {
	const now = Date.now();
	if (now - lastUpdateTime.value < UPDATE_INTERVAL && current < total) {
		return;
	}
	lastUpdateTime.value = now;

	const elapsed = Math.floor((now - startTime) / 1000);
	const speed = elapsed > 0 && current > 0 ? Math.round(current / elapsed) : 0;
	const progressText =
		`🔍 Анализ в процессе...\n\n` +
		`📊 Проанализировано: ${current} из ${total}\n` +
		`⏱ Время: ${elapsed} секунд${
			speed > 0 ? `\n⚡ Скорость: ${speed} сообщ/сек` : ''
		}`;

	try {
		await ctx.api.editMessageText(chatId, progressMessageId, progressText, {
			reply_markup: cancelKeyboard,
		});
	} catch (err) {
		console.error('Ошибка обновления прогресса:', err);
	}
}

function checkCancelled(chatId: number): void {
	const analysis = activeAnalyses.get(chatId);
	if (!analysis || analysis.cancel) throw new Error('cancelled');
}

async function analyzeMessage(
	msg: MessageData,
	index: number,
	total: number,
	controller: AbortController,
	violationsReport: string[]
): Promise<string | null> {
	const text = msg.text.toLowerCase();
	let violation: string | null = null;

	if (USE_NEURAL_NETWORK && text.length > 3) {
		if (index === 0 || index % NEURAL_LOG_FREQUENCY === 0) {
			console.log(
				`🧠 [${
					index + 1
				}/${total}] Вызываю нейросеть для анализа: "${text.substring(
					0,
					50
				)}..."`
			);
		}
		try {
			const neuralViolation = await analyzeSequentially(
				text,
				controller.signal
			);
			if (neuralViolation && typeof neuralViolation === 'object') {
				console.log(
					`🚨 [${index + 1}] Нейросеть обнаружила нарушение: ${
						neuralViolation.topic
					}`
				);
				violation = `neural_${neuralViolation.topic}`;
			}
		} catch (err) {
			if (err instanceof Error && err.message === 'cancelled') {
				throw err;
			}
			console.error(
				`❌ Ошибка нейросети при анализе сообщения ${index + 1}:`,
				err
			);
		}
	}

	if (!violation) {
		if (FILTER_PROFANITY && checkProfanity(text))
			violation = 'violation_profanity';
		if (FILTER_ADVERTISING && checkAd(text)) violation = 'violation_ad';
		if (checkCustom(text)) violation = 'violation_custom';
	}

	if (violation) {
		violationsReport.push(
			`${index + 1}\\. 👤 *${escapeMarkdownV2(msg.author)}*\n` +
				`⚠️ *${escapeMarkdownV2(getViolationReason(violation))}*\n` +
				`💬 "${escapeMarkdownV2(msg.text)}"`
		);
	}

	return violation;
}

async function sendViolationsReport(
	ctx: Context,
	violationsReport: string[],
	fileName: string
): Promise<void> {
	if (violationsReport.length === 0) {
		await ctx.reply(`✅ В файле ${fileName} нарушений не найдено.`);
		return;
	}

	const chunkSize = MAX_MESSAGE_LENGTH;
	let chunkText = '';

	for (const line of violationsReport) {
		if ((chunkText + '\n\n' + line).length > chunkSize) {
			await sendChunk(ctx, chunkText);
			chunkText = line;
		} else {
			chunkText += (chunkText ? '\n\n' : '') + line;
		}
	}

	if (chunkText) await sendChunk(ctx, chunkText);
}

async function sendChunk(ctx: Context, text: string): Promise<void> {
	for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
		const chunk = text.slice(i, i + MAX_MESSAGE_LENGTH);
		await ctx.reply(chunk, { parse_mode: 'MarkdownV2' });
	}
}

async function handleCancellation(
	ctx: Context,
	chatId: number,
	progressMessageId: number,
	index: number,
	total: number,
	startTime: number
): Promise<void> {
	const elapsed = Math.floor((Date.now() - startTime) / 1000);
	await ctx.api.editMessageText(
		chatId,
		progressMessageId,
		`🛑 Анализ прерван пользователем.\n\n📊 Проанализировано: ${index} из ${total}\n⏱ Время: ${elapsed} секунд`
	);
	activeAnalyses.delete(chatId);
}

export async function startAnalysis(
	ctx: Context,
	bot: Bot,
	chatId: number,
	messages: MessageData[],
	fileName: string,
	limit: number | null,
	totalFilesProcessed: number,
	onComplete?: () => void
) {
	const messagesToAnalyze =
		limit !== null ? messages.slice(0, limit) : messages;

	if (activeAnalyses.has(chatId)) {
		await ctx.reply(
			'⚠️ Анализ уже выполняется. Отмени его или дождись завершения.'
		);
		return;
	}

	const controller = new AbortController();
	activeAnalyses.set(chatId, { cancel: false, controller });
	const cancelKeyboard = createCancelKeyboard(chatId);

	const startMessage = await ctx.reply(
		`🔍 Начинаю анализ ${messagesToAnalyze.length} из ${messages.length} сообщений...\n\n📊 Проанализировано: 0 из ${messagesToAnalyze.length}\n⏱ Время: 0 секунд`,
		{ reply_markup: cancelKeyboard }
	);

	const startTime = Date.now();
	const progressMessageId = startMessage.message_id;
	const lastUpdateTime = { value: 0 };
	const violationsReport: string[] = [];

	for (const [index, msg] of messagesToAnalyze.entries()) {
		try {
			checkCancelled(chatId);
			await analyzeMessage(
				msg,
				index,
				messagesToAnalyze.length,
				controller,
				violationsReport
			);

			if (
				index % PROGRESS_UPDATE_FREQUENCY === 0 ||
				index === messagesToAnalyze.length - 1
			) {
				await updateProgress(
					ctx,
					chatId,
					progressMessageId,
					index + 1,
					messagesToAnalyze.length,
					startTime,
					lastUpdateTime,
					cancelKeyboard
				);
			}
		} catch (err) {
			if (err instanceof Error && err.message === 'cancelled') {
				await handleCancellation(
					ctx,
					chatId,
					progressMessageId,
					index,
					messagesToAnalyze.length,
					startTime
				);
				return;
			}
			console.error('Ошибка при обработке сообщения:', err);
		}
	}

	activeAnalyses.delete(chatId);
	const elapsed = Math.floor((Date.now() - startTime) / 1000);
	const speed =
		elapsed > 0
			? Math.round(messagesToAnalyze.length / elapsed)
			: messagesToAnalyze.length;

	try {
		await ctx.api.editMessageText(
			chatId,
			progressMessageId,
			`✅ Анализ завершён.\n\n📊 Проанализировано: ${messagesToAnalyze.length} из ${messagesToAnalyze.length}\n⏱ Время: ${elapsed} секунд\n⚡ Скорость: ${speed} сообщ/сек`
		);
	} catch (err) {
		console.error('Ошибка обновления финального сообщения:', err);
	}

	await sendViolationsReport(ctx, violationsReport, fileName);

	if (onComplete) onComplete();
}

export function createLimitKeyboard(chatId: number): InlineKeyboard {
	const callbackAll = `analyze_limit_${chatId}_all`;
	const callback500 = `analyze_limit_${chatId}_500`;
	const callback1000 = `analyze_limit_${chatId}_1000`;
	const callback2000 = `analyze_limit_${chatId}_2000`;
	const callback5000 = `analyze_limit_${chatId}_5000`;
	const callback10000 = `analyze_limit_${chatId}_10000`;
	const callbackCustom = `analyze_limit_${chatId}_custom`;

	return new InlineKeyboard()
		.text('📊 Все сообщения', callbackAll)
		.row()
		.text('500', callback500)
		.text('1000', callback1000)
		.row()
		.text('2000', callback2000)
		.text('5000', callback5000)
		.row()
		.text('10000', callback10000)
		.row()
		.text('✏️ Ввести число', callbackCustom);
}
