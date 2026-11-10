import { parentPort, workerData } from "node:worker_threads";
import { PhotonImage } from "@silvia-odwyer/photon-node";

// A fresh worker bounds codec lifetime and keeps untrusted decode off the Gateway thread.
try {
  const { data } = workerData as { data: Uint8Array };
  const image = PhotonImage.new_from_byteslice(data);
  try {
    const width = image.get_width(),
      height = image.get_height();
    if (width < 1 || height < 1 || width > 2048 || height > 2048) throw Error();
    parentPort?.postMessage({ width, height });
  } finally {
    image.free();
  }
} catch {
  parentPort?.postMessage({ error: "invalid_asset" });
}
