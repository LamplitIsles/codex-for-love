import { Capacitor } from "@capacitor/core";
import { Media } from "@capacitor-community/media";
export class ImageSaveUnavailableError extends Error {}
const ALBUM = "Lamplit";

/** Fetch through the authenticated web session, then save original bytes. */
export async function saveImage(url: string, filename: string): Promise<void> {
  if (Capacitor.isNativePlatform() && !Capacitor.isPluginAvailable("Media")) {
    throw new ImageSaveUnavailableError("Media plugin unavailable");
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error("Image unavailable");
  const blob = await response.blob();
  const name = filename.replace(/[\\/:*?"<>|]/g, "-").trim() || "image";
  if (!Capacitor.isNativePlatform()) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = /\.[a-z\d]+$/i.test(name)
      ? name
      : `${name}.${blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png"}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return;
  }
  const albumsPath =
    Capacitor.getPlatform() === "android"
      ? (await Media.getAlbumsPath()).path
      : undefined;
  const find = async () =>
    (await Media.getAlbums()).albums.find(
      (album) =>
        album.name === ALBUM &&
        (!albumsPath || album.identifier.startsWith(albumsPath)),
    );
  let album = await find();
  if (!album) {
    await Media.createAlbum({ name: ALBUM });
    album = await find();
  }
  if (!album) throw new Error("Album unavailable");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
  await Media.savePhoto({
    path: data,
    albumIdentifier: album.identifier,
    fileName: name.replace(/\.[^.]+$/, ""),
  });
}
