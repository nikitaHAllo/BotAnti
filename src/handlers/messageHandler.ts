import { Bot } from 'grammy';
import { ADMINS, ALLOWED_CHATS } from '../config.js';
import {
	FILTER_PROFANITY,
	FILTER_ADVERTISING,
	USE_NEURAL_NETWORK,
} from '../state.js';
import { checkProfanity, checkAd, checkCustom } from '../filters.js';
import { analyzeSequentially, analyzeAllTopics } from '../neural.js';
import { handleViolation } from './violationHandler.js';
import { dbPromise } from '../db.js';
import { getIsCheckingChat } from './commands.js';
import { getViolationReason } from './violationHandler.js';
import { processDocument } from './documentHandler.js';
import {
	activeAnalyses,
	pendingMessages,
	startAnalysis,
} from './messageAnalysis.js';
import { waitingForCustomLimit } from './callbacks.js';
import { MessageData } from './documentHandler.js';

function checkDocumentAccess(ctx: any): boolean {
	const fromId = ctx.from?.id;
	const isAdminUser = typeof fromId === 'number' && ADMINS.includes(fromId);
	const isAllowedChat =
		ALLOWED_CHATS.length === 0 || ALLOWED_CHATS.includes(ctx.chat.id);

	if (ctx.chat.type === 'private' && !isAdminUser) {
		return false;
	}

	return isAdminUser || isAllowedChat;
}

function detectViolation(text: string): string | null {
	if (USE_NEURAL_NETWORK && text.length > 3) {
		return null;
	}

	if (FILTER_PROFANITY && checkProfanity(text)) {
		return 'violation_profanity';
	}
	if (FILTER_ADVERTISING && checkAd(text)) {
		return 'violation_ad';
	}
	if (checkCustom(text)) {
		return 'violation_custom';
	}
	return null;
}

async function checkMessageWithNeural(text: string): Promise<string | null> {
	try {
		const neuralViolation = await analyzeSequentially(text);
		return neuralViolation ? `neural_${neuralViolation.topic}` : null;
	} catch (err: unknown) {
		if (err instanceof Error && err.message === 'cancelled') {
			throw err;
		}
		console.error('Ошибка нейросети:', err);
		return null;
	}
}

async function handleAdminCheckMode(ctx: any, text: string): Promise<void> {
	if (!text) {
		await ctx.reply('⚠️ Пустое сообщение — текст отсутствует.');
		return;
	}

	let checkViolation: string | null = null;
	try {
		const neuralResults = await analyzeAllTopics(text);
		const neuralViolation = neuralResults.find(r => r.detected);
		if (neuralViolation) {
			checkViolation = `neural_${neuralViolation.topic}`;
		}
	} catch {}

	if (!checkViolation) {
		if (checkProfanity(text)) checkViolation = 'violation_profanity';
		if (checkAd(text)) checkViolation = 'violation_ad';
		if (checkCustom(text)) checkViolation = 'violation_custom';
	}

	if (checkViolation) {
		await ctx.reply(
			`🚨 Обнаружено нарушение: ${getViolationReason(checkViolation)}`
		);
	} else {
		await ctx.reply('✅ Нарушений не обнаружено');
	}
}

async function handleCustomLimitInput(
	ctx: any,
	msgText: string,
	chatId: number,
	bot: Bot,
	allMessages: MessageData[],
	totalFilesProcessed: { value: number }
): Promise<boolean> {
	if (!waitingForCustomLimit.has(chatId)) return false;

	const pending = pendingMessages.get(chatId);
	if (!pending) {
		waitingForCustomLimit.delete(chatId);
		return false;
	}

	const limit = Number.parseInt(msgText.trim(), 10);
	if (isNaN(limit) || limit < 1) {
		await ctx.reply(
			`❌ Некорректное число. Введите число от 1 до ${pending.messages.length}:`
		);
		return true;
	}

	const actualLimit = Math.min(limit, pending.messages.length);
	waitingForCustomLimit.delete(chatId);
	pendingMessages.delete(chatId);

	await ctx.reply(`✅ Анализирую ${actualLimit} сообщений...`);
	await startAnalysis(
		ctx,
		bot,
		chatId,
		pending.messages,
		pending.fileName,
		actualLimit,
		totalFilesProcessed.value,
		() => {
			allMessages.length = 0;
			totalFilesProcessed.value = 0;
		}
	);
	return true;
}

export function registerMessageHandlers(
	bot: Bot,
	allMessages: MessageData[],
	totalFilesProcessed: { value: number }
) {
	bot.on('message', async ctx => {
		const chatId = ctx.chat.id;
		const msgText = ctx.message.text ?? ctx.message.caption ?? '';

		if (ctx.message.document) {
			if (waitingForCustomLimit.has(chatId)) {
				waitingForCustomLimit.delete(chatId);
				pendingMessages.delete(chatId);
			}

			if (!checkDocumentAccess(ctx)) {
				await ctx.reply('❌ Анализ файлов доступен только администраторам.');
				return;
			}

			const result = await processDocument(ctx, bot);
			if (result) {
				allMessages.push(...result.messages);
				totalFilesProcessed.value++;
				await ctx.reply(
					`✅ Файл ${result.fileName} загружен!\n` +
						`📨 Сообщений из файла: ${result.messages.length}\n` +
						`📊 Всего сообщений: ${allMessages.length}\n` +
						`📁 Обработано файлов: ${totalFilesProcessed.value}\n\n` +
						`Для анализа всех сообщений используйте команду /analyze`
				);
			}
			return;
		}

		if (
			await handleCustomLimitInput(
				ctx,
				msgText,
				chatId,
				bot,
				allMessages,
				totalFilesProcessed
			)
		) {
			return;
		}

		const text = msgText.toLowerCase();
		let violation: string | null = null;

		if (USE_NEURAL_NETWORK && text.length > 3) {
			try {
				violation = await checkMessageWithNeural(text);
			} catch (err: unknown) {
				if (err instanceof Error && err.message === 'cancelled') {
					await ctx.reply('🛑 Анализ прерван пользователем.');
					activeAnalyses.delete(chatId);
					return;
				}
			}
		}

		if (!violation) {
			violation = detectViolation(text);
		}

		if (violation) {
			await handleViolation(ctx, bot, violation);
		} else {
			const db = await dbPromise;
			await db.run('INSERT INTO statistics (type,timestamp) VALUES (?,?)', [
				'message_ok',
				Math.floor(Date.now() / 1000),
			]);
		}

		if (
			getIsCheckingChat() &&
			ctx.from &&
			ADMINS.includes(ctx.from.id) &&
			ctx.chat.type === 'private'
		) {
			await handleAdminCheckMode(ctx, text);
		}
	});
}
