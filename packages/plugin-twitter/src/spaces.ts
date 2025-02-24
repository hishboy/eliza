import {
    logger,
    type IAgentRuntime,
    ModelClass,
} from "@elizaos/core";
import type { ClientBase } from "./base.ts";
import {
    type Scraper,
    Space,
    type SpaceConfig,
    IdleMonitorPlugin,
    type SpeakerRequest,
    SpaceParticipant,
} from "./client/index.ts";
import { SttTtsPlugin } from "./sttTtsSpaces.ts";
import { generateTopicsIfEmpty, speakFiller } from "./utils.ts";

export interface TwitterSpaceDecisionOptions {
    maxSpeakers?: number;
    typicalDurationMinutes?: number;
    idleKickTimeoutMs?: number;
    minIntervalBetweenSpacesMinutes?: number;
    enableIdleMonitor?: boolean;
    enableSpaceHosting: boolean;
    enableRecording?: boolean;
    speakerMaxDurationMs?: number;
}

interface CurrentSpeakerState {
    userId: string;
    sessionUUID: string;
    username: string;
    startTime: number;
}

export enum SpaceActivity {
    HOSTING = "hosting",
    PARTICIPATING = "participating",
    IDLE = "idle"
}

/**
 * Main class: manage a Twitter Space with N speakers max, speaker queue, filler messages, etc.
 */
export class TwitterSpaceClient {
    private runtime: IAgentRuntime;
    private client: ClientBase;
    private scraper: Scraper;
    private currentSpace?: Space;
    private spaceId?: string;
    private startedAt?: number;
    private checkInterval?: NodeJS.Timeout;
    private lastSpaceEndedAt?: number;
    private sttTtsPlugin?: SttTtsPlugin;
    public spaceStatus: SpaceActivity = SpaceActivity.IDLE;
    private spaceParticipant: SpaceParticipant | null = null;

    /**
     * We now store an array of active speakers, not just 1
     */
    private activeSpeakers: CurrentSpeakerState[] = [];
    private speakerQueue: SpeakerRequest[] = [];

    private decisionOptions: TwitterSpaceDecisionOptions;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.scraper = client.twitterClient;
        this.runtime = runtime;

        // TODO: Spaces should be added to and removed from cache probably, and it should be possible to join or leave a space from an action, etc
        const charSpaces = runtime.character.settings?.twitter?.spaces || {};
        this.decisionOptions = {
            maxSpeakers: charSpaces.maxSpeakers ?? 1,
            typicalDurationMinutes: charSpaces.typicalDurationMinutes ?? 30,
            idleKickTimeoutMs: charSpaces.idleKickTimeoutMs ?? 5 * 60_000,
            minIntervalBetweenSpacesMinutes:
                charSpaces.minIntervalBetweenSpacesMinutes ?? 60,
            enableIdleMonitor: charSpaces.enableIdleMonitor !== false,
            enableRecording: charSpaces.enableRecording !== false,
            enableSpaceHosting: charSpaces.enableSpaceHosting || false,
            speakerMaxDurationMs: charSpaces.speakerMaxDurationMs ?? 4 * 60_000,
        };
    }

    /**
     * Periodic check to launch or manage space
     */
    public async startPeriodicSpaceCheck() {
        logger.log("[Space] Starting periodic check routine...");

        // For instance:
        const intervalMsWhenIdle = 5 * 60_000; // 5 minutes if no Space is running
        const intervalMsWhenRunning = 5_000; // 5 seconds if a Space IS running

        const routine = async () => {
            try {
                if (this.spaceStatus === SpaceActivity.IDLE) {
                    if (this.decisionOptions.enableSpaceHosting) {
                        // Space not running => check if we should launch
                        const launch = await this.shouldLaunchSpace();
                        if (launch) {
                            const config = await this.generateSpaceConfig();
                            await this.startSpace(config);
                        }
                    }
                    // Plan next iteration with a slower pace
                    this.checkInterval = setTimeout(
                        routine,
                        this.spaceStatus !== SpaceActivity.IDLE
                            ? intervalMsWhenRunning
                            : intervalMsWhenIdle
                    ) as any;
                } else {
                    if (this.spaceStatus === SpaceActivity.HOSTING) {
                        // Space is running => manage it more frequently
                        await this.manageCurrentSpace();
                    } else if (this.spaceStatus === SpaceActivity.PARTICIPATING) {
                        
                    }
                    
                    // Plan next iteration with a faster pace
                    this.checkInterval = setTimeout(
                        routine,
                        intervalMsWhenRunning
                    ) as any;
                }
            } catch (error) {
                logger.error("[Space] Error in routine =>", error);
                // In case of error, still schedule next iteration
                this.checkInterval = setTimeout(routine, intervalMsWhenIdle) as any;
            }
        };

        routine();
    }

    stopPeriodicCheck() {
        if (this.checkInterval) {
            clearTimeout(this.checkInterval);
            this.checkInterval = undefined;
        }
    }

    private async shouldLaunchSpace(): Promise<boolean> {
        // Interval
        const now = Date.now();
        if (this.lastSpaceEndedAt) {
            const minIntervalMs =
                (this.decisionOptions.minIntervalBetweenSpacesMinutes ?? 60) *
                60_000;
            if (now - this.lastSpaceEndedAt < minIntervalMs) {
                logger.log("[Space] Too soon since last space => skip");
                return false;
            }
        }

        logger.log("[Space] Deciding to launch a new Space...");
        return true;
    }

    private async generateSpaceConfig(): Promise<SpaceConfig> {
        let chosenTopic = "Random Tech Chat";
        let topics = this.runtime.character.topics || [];
        if (!topics.length) {
            const newTopics = await generateTopicsIfEmpty(this.client.runtime);
            topics = newTopics;
        }

        chosenTopic =
            topics[
                Math.floor(
                    Math.random() * topics.length
                )
            ];
        

        return {
            record: this.decisionOptions.enableRecording,
            mode: "INTERACTIVE",
            title: chosenTopic,
            description: `Discussion about ${chosenTopic}`,
            languages: ["en"],
        };
    }

    public async startSpace(config: SpaceConfig) {
        logger.log("[Space] Starting a new Twitter Space...");

        try {
            this.currentSpace = new Space(this.scraper);
            this.spaceStatus = SpaceActivity.IDLE;
            this.spaceId = undefined;
            this.startedAt = Date.now();

            // Reset states
            this.activeSpeakers = [];
            this.speakerQueue = [];

            const broadcastInfo = await this.currentSpace.initialize(config);
            this.spaceId = broadcastInfo.room_id;

            if (
                this.runtime.getModel(ModelClass.TEXT_TO_SPEECH) && 
                this.runtime.getModel(ModelClass.TRANSCRIPTION)
            ) {
                logger.log("[Space] Using SttTtsPlugin");
                const sttTts = new SttTtsPlugin();
                this.sttTtsPlugin = sttTts;
                // TODO: There is an error here, onAttach is incompatible
                this.currentSpace.use(sttTts as any, {
                    runtime: this.runtime,
                    spaceId: this.spaceId,
                });
            }

            if (this.decisionOptions.enableIdleMonitor) {
                logger.log("[Space] Using IdleMonitorPlugin");
                this.currentSpace.use(
                    new IdleMonitorPlugin(
                        this.decisionOptions.idleKickTimeoutMs ?? 60_000,
                        10_000
                    )
                );
            }
            this.spaceStatus = SpaceActivity.HOSTING;
            await this.scraper.sendTweet(
                broadcastInfo.share_url.replace("broadcasts", "spaces")
            );

            const spaceUrl = broadcastInfo.share_url.replace(
                "broadcasts",
                "spaces"
            );
            logger.log(`[Space] Space started => ${spaceUrl}`);

            // Greet
            await speakFiller(
                this.client.runtime,
                this.sttTtsPlugin,
                "WELCOME"
            );

            // Events
            this.currentSpace.on("occupancyUpdate", (update) => {
                logger.log(
                    `[Space] Occupancy => ${update.occupancy} participant(s).`
                );
            });

            this.currentSpace.on(
                "speakerRequest",
                async (req: SpeakerRequest) => {
                    logger.log(
                        `[Space] Speaker request from @${req.username} (${req.userId}).`
                    );
                    await this.handleSpeakerRequest(req);
                }
            );

            this.currentSpace.on("idleTimeout", async (info) => {
                logger.log(
                    `[Space] idleTimeout => no audio for ${info.idleMs} ms.`
                );
                await speakFiller(
                    this.client.runtime,
                    this.sttTtsPlugin,
                    "IDLE_ENDING"
                );
                await this.stopSpace();
            });

            process.on("SIGINT", async () => {
                logger.log("[Space] SIGINT => stopping space");
                await speakFiller(
                    this.client.runtime,
                    this.sttTtsPlugin,
                    "CLOSING"
                );
                await this.stopSpace();
                process.exit(0);
            });
        } catch (error) {
            logger.error("[Space] Error launching Space =>", error);
            this.spaceStatus = SpaceActivity.IDLE;
            throw error;
        }
    }

    /**
     * Periodic management: check durations, remove extras, maybe accept new from queue
     */
    private async manageCurrentSpace() {
        if (!this.spaceId || !this.currentSpace) return;
        try {
            const audioSpace = await this.scraper.getAudioSpaceById(
                this.spaceId
            );
            const { participants } = audioSpace;
            const numSpeakers = participants.speakers?.length || 0;
            const totalListeners = participants.listeners?.length || 0;

            // 1) Remove any speaker who exceeded speakerMaxDurationMs
            const maxDur = this.decisionOptions.speakerMaxDurationMs ?? 240_000;
            const now = Date.now();

            for (let i = this.activeSpeakers.length - 1; i >= 0; i--) {
                const speaker = this.activeSpeakers[i];
                const elapsed = now - speaker.startTime;
                if (elapsed > maxDur) {
                    logger.log(
                        `[Space] Speaker @${speaker.username} exceeded max duration => removing`
                    );
                    await this.removeSpeaker(speaker.userId);
                    this.activeSpeakers.splice(i, 1);

                    // Possibly speak a short "SPEAKER_LEFT" filler
                    await speakFiller(
                        this.client.runtime,
                        this.sttTtsPlugin,
                        "SPEAKER_LEFT"
                    );
                }
            }

            // 2) If we have capacity for new speakers from the queue, accept them
            await this.acceptSpeakersFromQueueIfNeeded();

            // 3) If somehow more than maxSpeakers are active, remove the extras
            if (numSpeakers > (this.decisionOptions.maxSpeakers ?? 1)) {
                logger.log(
                    "[Space] More than maxSpeakers => removing extras..."
                );
                await this.kickExtraSpeakers(participants.speakers);
            }

            // 4) Possibly stop the space if empty or time exceeded
            const elapsedMinutes = (now - (this.startedAt || 0)) / 60000;
            if (
                elapsedMinutes >
                    (this.decisionOptions.typicalDurationMinutes ?? 30) ||
                (numSpeakers === 0 &&
                    totalListeners === 0 &&
                    elapsedMinutes > 5)
            ) {
                logger.log(
                    "[Space] Condition met => stopping the Space..."
                );
                await speakFiller(
                    this.client.runtime,
                    this.sttTtsPlugin,
                    "CLOSING",
                    4000
                );
                await this.stopSpace();
            }
        } catch (error) {
            logger.error("[Space] Error in manageCurrentSpace =>", error);
        }
    }

    /**
     * If we have available slots, accept new speakers from the queue
     */
    private async acceptSpeakersFromQueueIfNeeded() {
        // while queue not empty and activeSpeakers < maxSpeakers, accept next
        const ms = this.decisionOptions.maxSpeakers ?? 1;
        while (
            this.speakerQueue.length > 0 &&
            this.activeSpeakers.length < ms
        ) {
            const nextReq = this.speakerQueue.shift();
            if (nextReq) {
                await speakFiller(
                    this.client.runtime,
                    this.sttTtsPlugin,
                    "PRE_ACCEPT"
                );
                await this.acceptSpeaker(nextReq);
            }
        }
    }

    private async handleSpeakerRequest(req: SpeakerRequest) {
        if (!this.spaceId || !this.currentSpace) return;

        const audioSpace = await this.scraper.getAudioSpaceById(this.spaceId);
        const janusSpeakers = audioSpace?.participants?.speakers || [];

        // If we haven't reached maxSpeakers, accept immediately
        if (janusSpeakers.length < (this.decisionOptions.maxSpeakers ?? 1)) {
            logger.log(`[Space] Accepting speaker @${req.username} now`);
            await speakFiller(
                this.client.runtime,
                this.sttTtsPlugin,
                "PRE_ACCEPT"
            );
            await this.acceptSpeaker(req);
        } else {
            logger.log(
                `[Space] Adding speaker @${req.username} to the queue`
            );
            this.speakerQueue.push(req);
        }
    }

    private async acceptSpeaker(req: SpeakerRequest) {
        if (!this.currentSpace) return;
        try {
            await this.currentSpace.approveSpeaker(req.userId, req.sessionUUID);
            this.activeSpeakers.push({
                userId: req.userId,
                sessionUUID: req.sessionUUID,
                username: req.username,
                startTime: Date.now(),
            });
            logger.log(`[Space] Speaker @${req.username} is now live`);
        } catch (err) {
            logger.error(
                `[Space] Error approving speaker @${req.username}:`,
                err
            );
        }
    }

    private async removeSpeaker(userId: string) {
        if (!this.currentSpace) return;
        try {
            await this.currentSpace.removeSpeaker(userId);
            logger.log(`[Space] Removed speaker userId=${userId}`);
        } catch (error) {
            logger.error(
                `[Space] Error removing speaker userId=${userId} =>`,
                error
            );
        }
    }

    /**
     * If more than maxSpeakers are found, remove extras
     * Also update activeSpeakers array
     */
    private async kickExtraSpeakers(speakers: any[]) {
        if (!this.currentSpace) return;
        const ms = this.decisionOptions.maxSpeakers ?? 1;

        // sort by who joined first if needed, or just slice
        const extras = speakers.slice(ms);
        for (const sp of extras) {
            logger.log(
                `[Space] Removing extra speaker => userId=${sp.user_id}`
            );
            await this.removeSpeaker(sp.user_id);

            // remove from activeSpeakers array
            const idx = this.activeSpeakers.findIndex(
                (s) => s.userId === sp.user_id
            );
            if (idx !== -1) {
                this.activeSpeakers.splice(idx, 1);
            }
        }
    }

    public async stopSpace() {
        if (!this.currentSpace || this.spaceStatus === SpaceActivity.IDLE) return;
        try {
            logger.log("[Space] Stopping the current Space...");
            await this.currentSpace.stop();
        } catch (err) {
            logger.error("[Space] Error stopping Space =>", err);
        } finally {
            this.spaceStatus = SpaceActivity.IDLE;
            this.spaceId = undefined;
            this.currentSpace = undefined;
            this.startedAt = undefined;
            this.lastSpaceEndedAt = Date.now();
            this.activeSpeakers = [];
            this.speakerQueue = [];
        }
    }

    async joinSpace(spaceId: string) {
        if (this.spaceStatus !== SpaceActivity.IDLE) {
            logger.warn("currently hosting/participating a space");
            return null;
        }

        if (!this.spaceParticipant) {
            this.spaceParticipant = new SpaceParticipant(this.client.twitterClient, {
                debug: false,
            });
        }
        if (this.spaceParticipant) {
            try {
                await this.spaceParticipant.joinAsListener(spaceId);
                this.spaceStatus = SpaceActivity.PARTICIPATING;

                const { sessionUUID } = await this.spaceParticipant.requestSpeaker();
                console.log('[TestParticipant] Requested speaker =>', sessionUUID);
                try {
                    await this.waitForApproval(this.spaceParticipant, sessionUUID, 15000);
                    console.log(
                      '[TestParticipant] Speaker approval sequence completed (ok or timed out).',
                    );
                    const sttTts = new SttTtsPlugin();
                    this.sttTtsPlugin = sttTts;
                    this.spaceParticipant.use(sttTts as any, {
                        runtime: this.runtime,
                        spaceId: this.spaceId,
                    });
                  } catch (err) {
                    console.error('[TestParticipant] Approval error or timeout =>', err);
                    // Optionally cancel the request if we timed out or got an error
                    try {
                      await this.spaceParticipant.cancelSpeakerRequest();
                      console.log(
                        '[TestParticipant] Speaker request canceled after timeout or error.',
                      );
                    } catch (cancelErr) {
                      console.error(
                        '[TestParticipant] Could not cancel the request =>',
                        cancelErr,
                      );
                    }
                  }

                return spaceId;
            } catch(error) {
                logger.error(`failed to join space ${error}`);
                return null;
            }
        }
    }

    /**
     * waitForApproval waits until "newSpeakerAccepted" matches our sessionUUID,
     * then calls becomeSpeaker() or rejects after a given timeout.
     */
    async waitForApproval(
        participant: SpaceParticipant,
        sessionUUID: string,
        timeoutMs = 10000,
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
        let resolved = false;
    
        const handler = async (evt: { sessionUUID: string }) => {
            if (evt.sessionUUID === sessionUUID) {
            resolved = true;
            participant.off('newSpeakerAccepted', handler);
            try {
                await participant.becomeSpeaker();
                console.log('[TestParticipant] Successfully became speaker!');
                resolve();
            } catch (err) {
                reject(err);
            }
            }
        };
    
        // Listen to "newSpeakerAccepted" from participant
        participant.on('newSpeakerAccepted', handler);
    
        // Timeout to reject if not approved in time
        setTimeout(() => {
            if (!resolved) {
            participant.off('newSpeakerAccepted', handler);
            reject(
                new Error(
                `[TestParticipant] Timed out waiting for speaker approval after ${timeoutMs}ms.`,
                ),
            );
            }
        }, timeoutMs);
        });
    }
}
