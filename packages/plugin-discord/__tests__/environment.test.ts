import { describe, it, expect } from 'vitest';
import { validateDiscordConfig } from '../src/environment';
import type { IAgentRuntime } from '@elizaos/core';

// Mock runtime environment
const mockRuntime: IAgentRuntime = {
    env: {
        DISCORD_API_TOKEN: 'mocked-discord-token',
    },
    getEnv: function (key: string) {
        return this.env[key] || null;
    },
    getSetting: function (key: string) {
        return this.env[key] || null;
    }
} as unknown as IAgentRuntime;

describe('Discord Environment Configuration', () => {
    it('should validate correct configuration', async () => {
        const config = await validateDiscordConfig(mockRuntime);
        expect(config).toBeDefined();
        expect(config.DISCORD_API_TOKEN).toBe('mocked-discord-token');
    });

    it('should throw an error when DISCORD_API_TOKEN is missing', async () => {
        const invalidRuntime = {
            ...mockRuntime,
            env: {
                ...mockRuntime.env,
                DISCORD_API_TOKEN: undefined,
            },
        } as IAgentRuntime;

        await expect(validateDiscordConfig(invalidRuntime)).rejects.toThrowError(
            'Discord configuration validation failed:\nDISCORD_API_TOKEN: Discord API token is required'
        );
    });
});
