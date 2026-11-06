import { refreshAccountProfile } from "../../../utils/account-profile";

export default defineEventHandler(event => refreshAccountProfile(event, "waimai"));
