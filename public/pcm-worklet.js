class PcmWorkletProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    const firstChannel = channels?.[0];
    if (!firstChannel?.length) return true;

    // AudioWorklet input buffers are owned by the audio engine, so copy once
    // into a transferable mono buffer and avoid any intermediate allocations.
    const mono = new Float32Array(firstChannel.length);

    if (channels.length === 1) {
      mono.set(firstChannel);
    } else {
      const scale = 1 / channels.length;
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        const channel = channels[channelIndex];
        for (let sampleIndex = 0; sampleIndex < mono.length; sampleIndex += 1) {
          mono[sampleIndex] += channel[sampleIndex] * scale;
        }
      }
    }

    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorkletProcessor);
