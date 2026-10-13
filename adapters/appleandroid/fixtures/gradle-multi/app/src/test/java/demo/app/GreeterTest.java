package demo.app;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
class GreeterTest {
    @Test void totalFormats() { assertEquals("total=5", Greeter.total(2, 3)); }
}
