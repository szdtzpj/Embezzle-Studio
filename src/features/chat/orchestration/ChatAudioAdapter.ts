import {
  synthesizeSpeech,
  transcribeAudio,
  type SynthesizeSpeechArgs,
  type SynthesizeSpeechResult,
  type TranscribeAudioArgs,
  type TranscribeAudioResult,
} from '../../../services/providerAudio';

export interface ChatAudioAdapter {
  transcribe(request: TranscribeAudioArgs): Promise<TranscribeAudioResult>;
  synthesize(request: SynthesizeSpeechArgs): Promise<SynthesizeSpeechResult>;
}

class ProductionChatAudioAdapter implements ChatAudioAdapter {
  transcribe(request: TranscribeAudioArgs): Promise<TranscribeAudioResult> {
    return transcribeAudio(request);
  }

  synthesize(request: SynthesizeSpeechArgs): Promise<SynthesizeSpeechResult> {
    return synthesizeSpeech(request);
  }
}

export function createProductionChatAudioAdapter(): ChatAudioAdapter {
  return new ProductionChatAudioAdapter();
}
