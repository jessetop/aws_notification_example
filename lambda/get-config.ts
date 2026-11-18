/** Returns each channel's enabled flag + config for the workflow fan-out. */
import { getChannels } from './shared/ddb';

export const handler = async () => getChannels();
