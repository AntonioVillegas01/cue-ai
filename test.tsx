type Product = {
    id: string | number;
    name: string;
    price: number;
};

type ProductListProps = {
    products: Product[];
};

/*
 1.- Track the search term and the currently selected product as local state
 2.- Filter the incoming products by matching the search term against the name
 3.- Render the filtered list, each item with a button to select it
 4.- Show the details of the selected product, if one is chosen
*/
export default function ProductList({ products }: ProductListProps) {
    const [search, setSearch] = useState('');
    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

    const filteredProducts = products.filter((product) =>
        product.name.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div>
            <h1>Products</h1>
            <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search products"
            />

            {filteredProducts.map((product) => (
                <div key={product.id}>
                    <h3>{product.name}</h3>
                    <p>${product.price}</p>
                    <button onClick={() => setSelectedProduct(product)}>Select</button>
                </div>
            ))}

            {selectedProduct && (
                <div>
                    <h2>Selected Product</h2>
                    <p>{selectedProduct.name}</p>
                    <p>${selectedProduct.price}</p>
                </div>
            )}
        </div>
    );
}
