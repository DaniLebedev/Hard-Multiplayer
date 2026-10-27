using HarmonyLib;

namespace HardMultiplayer;

/// <summary>
/// Drives the mod from the game's own per-frame player update. We cannot add a
/// managed MonoBehaviour: BepInEx 6's ClassInjector crashes on this Unity 6
/// build, and Harmony patches do not need type injection.
/// </summary>
[HarmonyPatch(typeof(PlayerRoot), nameof(PlayerRoot.Update))]
internal static class PlayerRootUpdatePatch
{
    private static void Postfix()
    {
        Plugin.Instance?.Tick();
    }
}
