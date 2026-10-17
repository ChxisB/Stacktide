/** The program that shows a URL in the user's browser, by platform (the URL is added as its last argument). */
export const openCommand = (platform: string) =>
  platform === "darwin"
    ? ["open"]
    : platform === "win32"
      ? ["rundll32", "url.dll,FileProtocolHandler"] // `start` would read the `&` of the URL as a command
      : ["xdg-open"];
