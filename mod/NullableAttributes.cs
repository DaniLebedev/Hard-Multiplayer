// The generated Il2Cpp interop assemblies forward System.Runtime.CompilerServices.NullableAttribute
// to System.Private.CoreLib. When the compiler decodes nullable metadata from those assemblies it
// finds the internal BCL attribute (no accessible constructor) and fails with CS0656. Defining the
// attributes locally makes the compiler use these instead. They are never used at runtime.
namespace System.Runtime.CompilerServices;

[AttributeUsage(
    AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Method | AttributeTargets.Property |
    AttributeTargets.Field | AttributeTargets.Event | AttributeTargets.Parameter | AttributeTargets.ReturnValue |
    AttributeTargets.GenericParameter,
    AllowMultiple = false,
    Inherited = false)]
internal sealed class NullableAttribute : Attribute
{
    public NullableAttribute(byte value)
    {
    }

    public NullableAttribute(byte[] value)
    {
    }
}

[AttributeUsage(
    AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Method | AttributeTargets.Interface |
    AttributeTargets.Delegate | AttributeTargets.Enum | AttributeTargets.Module,
    AllowMultiple = false,
    Inherited = false)]
internal sealed class NullableContextAttribute : Attribute
{
    public NullableContextAttribute(byte value)
    {
    }
}
