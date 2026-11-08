import { defineEventHandler } from "h3";
import { refreshAccountProfile } from "../../../utils/account-profile";

export default defineEventHandler(event => refreshAccountProfile(event, "waimai"));
