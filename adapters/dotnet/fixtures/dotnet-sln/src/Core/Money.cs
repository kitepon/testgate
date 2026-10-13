namespace Fx.Core;

public record Money(decimal Amount, string Currency)
{
    public Money Add(Money other) => this with { Amount = Amount + other.Amount };
}
