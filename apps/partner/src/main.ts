import { mount } from "svelte";
import "./lib/companion/client/framework7.ts";
import "./style.css";
import App from "./App.svelte";
// Modal URLs are transient: a fresh load always starts with the chat page.
if (location.hash.startsWith("#!"))
  history.replaceState(null, "", location.pathname + location.search);
mount(App, { target: document.getElementById("app")! });
